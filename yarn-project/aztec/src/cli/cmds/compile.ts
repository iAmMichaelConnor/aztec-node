import { findBbBinary } from '@aztec-foundation/bb.js';

import { getEnv } from '@aztec-labs/foundation/config/env';
import type { LogFn } from '@aztec-labs/foundation/log';
import { UNCONSTRAINED_BUILD_COMPLETE_FILE, UNCONSTRAINED_BUILD_DIR } from '@aztec-labs/stdlib/noir';
import { getPackageVersion } from '@aztec-labs/stdlib/update-checker';
import { execFileSync } from 'child_process';
import type { Command } from 'commander';
import { existsSync } from 'fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { type CompiledArtifact, readArtifactFiles } from './utils/artifacts.js';
import { needsRecompile } from './utils/needs_recompile.js';
import { run } from './utils/spawn.js';
import { warnIfAztecVersionMismatch } from './utils/warn_if_aztec_version_mismatch.js';

const UNCONSTRAINED_FLAG = '--unconstrained';
/** Where `aztec compile --unconstrained` writes artifacts, so that they never sit next to deployable ones. */
const UNCONSTRAINED_TARGET_DIR = join('target', UNCONSTRAINED_BUILD_DIR);
/** Written once every artifact of an unconstrained build is in place, and removed before the next build starts. */
const UNCONSTRAINED_BUILD_COMPLETE = join(UNCONSTRAINED_TARGET_DIR, UNCONSTRAINED_BUILD_COMPLETE_FILE);
/**
 * The hidden nargo options that compile every function as unconstrained code. A private function compiled this way is
 * a circuit without constraints, which nargo does not record in the artifact.
 */
const UNCONSTRAINED_CODE_NARGO_OPTIONS = ['--force-brillig', '--minimal-ssa'];
/** The nargo options that `--unconstrained` sets itself. */
const NARGO_OPTIONS_SET_BY_UNCONSTRAINED = ['--force-brillig', '--inliner-aggressiveness', '--target-dir'];

/** Returns the first of the given nargo options that is among the arguments, as `--option` or `--option=value`. */
function findOption(nargoArgs: string[], options: string[]): string | undefined {
  return nargoArgs.find(arg => options.includes(arg.split('=')[0]));
}

/** Returns contract artifacts in the target directory along with whether each has already been postprocessed. */
async function collectContractArtifacts(): Promise<ContractArtifactInfo[]> {
  let files;
  try {
    files = await readArtifactFiles('target');
  } catch (err: any) {
    if (err?.message?.includes('does not exist')) {
      return [];
    }
    throw err;
  }
  return files
    .filter(f => Array.isArray(f.content.functions))
    .map(f => ({ filePath: f.filePath, transpiled: f.content.transpiled === true }));
}

/** Stamps the Aztec stack version into the contract artifacts. */
async function stampAztecVersion(artifactPaths: string[]): Promise<void> {
  const version = getPackageVersion();
  for (const path of artifactPaths) {
    const artifact = JSON.parse(await readFile(path, 'utf-8'));
    // eslint-disable-next-line camelcase
    artifact.aztec_version = version;
    await writeFile(path, JSON.stringify(artifact, null, 2) + '\n');
  }
}

/** Returns the set of package names that are contract crates in the current workspace. */
async function getContractPackageNames(): Promise<Set<string>> {
  const contractNames = new Set<string>();

  let rootToml: string;
  try {
    rootToml = await readFile('Nargo.toml', 'utf-8');
  } catch {
    return contractNames;
  }

  const membersMatch = rootToml.match(/members\s*=\s*\[([^\]]*)\]/);
  if (membersMatch) {
    const members = membersMatch[1]
      .split(',')
      .map(m => m.trim().replace(/^"|"$/g, ''))
      .filter(m => m.length > 0);

    for (const member of members) {
      try {
        const memberToml = await readFile(join(member, 'Nargo.toml'), 'utf-8');
        if (/type\s*=\s*"contract"/.test(memberToml)) {
          const nameMatch = memberToml.match(/name\s*=\s*"([^"]+)"/);
          if (nameMatch) {
            contractNames.add(nameMatch[1]);
          }
        }
      } catch {
        // Member directory might not exist or have no Nargo.toml; skip.
      }
    }
  } else {
    // Single-crate project (no workspace): check if the root Nargo.toml itself is a contract.
    if (/type\s*=\s*"contract"/.test(rootToml)) {
      const nameMatch = rootToml.match(/name\s*=\s*"([^"]+)"/);
      if (nameMatch) {
        contractNames.add(nameMatch[1]);
      }
    }
  }

  return contractNames;
}

/** Checks that no tests exist in contract crates and fails with a helpful message if they do. */
async function checkNoTestsInContracts(nargo: string, log: LogFn): Promise<void> {
  const contractPackages = await getContractPackageNames();
  if (contractPackages.size === 0) {
    return;
  }

  let output: string;
  try {
    // We list tests for all the crates in the workspace
    output = execFileSync(nargo, ['test', '--list-tests', '--silence-warnings'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'inherit'],
    });
  } catch {
    // If listing tests fails (e.g. test crate has compile errors), skip the check.
    return;
  }

  // The output of the `nargo test --list-tests` command is as follows:
  // ```
  // crate_name_1 test_name_1
  // crate_name_2 test_name_2
  // ...
  // crate_name_n test_name_n
  // ```
  //
  // We parse the individual lines and then we check if any contract crate appeared in the parsed output.
  const lines = output
    .trim()
    .split('\n')
    .filter(line => line.length > 0);
  const testsInContracts: { packageName: string; testName: string }[] = [];

  for (const line of lines) {
    const spaceIndex = line.indexOf(' ');
    if (spaceIndex === -1) {
      continue;
    }
    const packageName = line.substring(0, spaceIndex);
    const testName = line.substring(spaceIndex + 1);
    if (contractPackages.has(packageName)) {
      testsInContracts.push({ packageName, testName });
    }
  }

  if (testsInContracts.length > 0) {
    const details = testsInContracts.map(t => `  ${t.packageName}::${t.testName}`).join('\n');
    log(
      `WARNING: Found tests in contract crate(s):\n${details}\n\n` +
        `Tests should be in a dedicated test crate, not in the contract crate.\n` +
        `Learn more: https://docs.aztec.network/errors/1`,
    );
  }
}

/**
 * Compiles Aztec Noir contracts for tests only: private functions become unconstrained code instead of circuits,
 * which nargo compiles far faster for large functions and which is all that executing them takes.
 *
 * The proof of such a function proves nothing, so the build must never be deployable:
 * - it is assembled in a temporary directory outside the workspace, and only finished contract artifacts are copied to
 *   the build's directory;
 * - its functions are declared unconstrained before bb runs, as bb generates verification keys for constrained private
 *   functions only, and the class of a contract with a private function cannot be computed without them;
 * - it is marked, which the artifact loaders reject.
 */
async function compileUnconstrained(nargoArgs: string[], nargo: string, bb: string, log: LogFn): Promise<void> {
  const conflicting = findOption(nargoArgs, NARGO_OPTIONS_SET_BY_UNCONSTRAINED);
  if (conflicting !== undefined) {
    throw new Error(`${conflicting} cannot be combined with ${UNCONSTRAINED_FLAG}, which sets it itself.`);
  }
  if (existsSync(UNCONSTRAINED_BUILD_COMPLETE) && !(await needsRecompile(UNCONSTRAINED_TARGET_DIR))) {
    log('No source changes detected, skipping compilation.');
    return;
  }

  await mkdir(UNCONSTRAINED_TARGET_DIR, { recursive: true });
  await rm(UNCONSTRAINED_BUILD_COMPLETE, { force: true });
  // Outside the workspace, so that what an interrupted compilation leaves behind is not found by anything that scans
  // target directories for artifacts.
  const stagingDir = await mkdtemp(join(tmpdir(), 'aztec-unconstrained-'));
  try {
    // Without inlining, the default of which can take many minutes on large functions compiled as unconstrained code.
    const unconstrainedArgs = ['--force-brillig', '--inliner-aggressiveness', '0'];
    await run(nargo, ['compile', ...unconstrainedArgs, '--target-dir', stagingDir, ...nargoArgs]);

    // Programs that are not contracts are left behind in the staging directory: they could not be marked.
    const contracts = (await readArtifactFiles(stagingDir)).filter(f => Array.isArray(f.content.functions));
    const rewrite = async (update: (artifact: CompiledArtifact) => void) => {
      for (const { filePath } of contracts) {
        const artifact: CompiledArtifact = JSON.parse(await readFile(filePath, 'utf-8'));
        update(artifact);
        await writeFile(filePath, JSON.stringify(artifact, null, 2) + '\n');
      }
    };

    await rewrite(artifact => {
      for (const fn of artifact.functions) {
        // eslint-disable-next-line camelcase
        fn.is_unconstrained = true;
      }
    });
    if (contracts.length > 0) {
      log('Postprocessing contracts...');
      await run(bb, ['aztec_process', ...contracts.flatMap(a => ['-i', a.filePath])]);
    }
    // The transpiler drops fields it does not know, so the artifact is marked and stamped after it has run.
    const version = getPackageVersion();
    await rewrite(artifact => {
      if (artifact.functions.some(fn => fn.verification_key !== undefined || !fn.is_unconstrained)) {
        throw new Error(
          'An unconstrained build has a verification key or a function that is not declared unconstrained.',
        );
      }
      artifact.unconstrained = true;
      // eslint-disable-next-line camelcase
      artifact.aztec_version = version;
    });

    for (const { filePath, name } of contracts) {
      const artifactPath = join(UNCONSTRAINED_TARGET_DIR, `${name}.json`);
      await copyFile(filePath, `${artifactPath}.partial`);
      await rename(`${artifactPath}.partial`, artifactPath);
    }
    await writeFile(UNCONSTRAINED_BUILD_COMPLETE, '');
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  // Ensure contract crates contain no tests (tests belong in the test crate).
  await checkNoTestsInContracts(nargo, log);
  log('Compilation complete!');
}

/** Compiles Aztec Noir contracts and postprocesses artifacts. */
async function compileAztecContract(nargoArgs: string[], unconstrained: boolean, log: LogFn): Promise<void> {
  await warnIfAztecVersionMismatch(log);

  const nargo = getEnv().NARGO ?? 'nargo';
  const bb = getEnv().BB ?? findBbBinary() ?? 'bb';

  if (unconstrained) {
    return compileUnconstrained(nargoArgs, nargo, bb, log);
  }
  const unconstrainedCodeOption = findOption(nargoArgs, UNCONSTRAINED_CODE_NARGO_OPTIONS);
  if (unconstrainedCodeOption !== undefined) {
    throw new Error(
      `${unconstrainedCodeOption} compiles private functions as unconstrained code, and the artifact would be given verification keys as if they were circuits. Use ${UNCONSTRAINED_FLAG} to compile contracts this way, for tests.`,
    );
  }

  const shouldRecompile = await needsRecompile();
  if (shouldRecompile) {
    await run(nargo, ['compile', ...nargoArgs]);

    // Ensure contract crates contain no tests (tests belong in the test crate).
    await checkNoTestsInContracts(nargo, log);
  }

  // Postprocess any untranspiled artifacts: those just produced by nargo above, and any left behind by a bare
  // `nargo compile` run outside `aztec compile`.
  const unprocessed = (await collectContractArtifacts()).filter(a => !a.transpiled).map(a => a.filePath);

  if (unprocessed.length > 0) {
    log('Postprocessing contracts...');
    const bbArgs = unprocessed.flatMap(a => ['-i', a]);
    await run(bb, ['aztec_process', ...bbArgs]);

    await stampAztecVersion(unprocessed);
  }

  if (shouldRecompile || unprocessed.length > 0) {
    log('Compilation complete!');
  } else {
    log('No source changes detected, skipping compilation.');
  }
}

export function injectCompileCommand(program: Command, log: LogFn): Command {
  program
    .command('compile')
    .argument('[nargo-args...]')
    .passThroughOptions()
    .allowUnknownOption()
    .option(
      UNCONSTRAINED_FLAG,
      `Compile private functions as unconstrained code, for tests only. Much faster for contracts with large private functions. Artifacts are written to ${UNCONSTRAINED_TARGET_DIR}, have no verification keys and cannot be deployed.`,
    )
    .description(
      'Compile Aztec Noir contracts using nargo and postprocess them to generate transpiled artifacts and verification keys. All other options are forwarded to nargo compile.',
    )
    .addHelpText('after', () => {
      // Show nargo's own compile options so users see all available flags in one place.
      const nargo = getEnv().NARGO ?? 'nargo';
      try {
        const output = execFileSync(nargo, ['compile', '--help'], { encoding: 'utf-8' });
        return `\nUnderlying nargo compile options:\n\n${output}`;
      } catch {
        return '\n(Run "nargo compile --help" to see available nargo options)';
      }
    })
    .action((nargoArgs: string[], options: { unconstrained?: boolean }) =>
      // Options after the first nargo argument are passed through unparsed, so the flag may also be among them.
      compileAztecContract(
        nargoArgs.filter(arg => arg !== UNCONSTRAINED_FLAG),
        options.unconstrained === true || nargoArgs.includes(UNCONSTRAINED_FLAG),
        log,
      ),
    );

  return program;
}

interface ContractArtifactInfo {
  /** Path to the artifact JSON in the target directory. */
  filePath: string;
  /** Whether the artifact has already been transpiled and had its verification keys generated. */
  transpiled: boolean;
}
