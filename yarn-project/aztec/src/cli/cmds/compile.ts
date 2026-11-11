import { findBbBinary } from '@aztec-foundation/bb.js';

import { getEnv } from '@aztec-labs/foundation/config/env';
import type { LogFn } from '@aztec-labs/foundation/log';
import { UNCONSTRAINED_BUILD_DIR } from '@aztec-labs/stdlib/noir';
import { getPackageVersion } from '@aztec-labs/stdlib/update-checker';
import { execFileSync } from 'child_process';
import type { Command } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import { type CompiledArtifact, readArtifactFiles } from './utils/artifacts.js';
import { needsRecompile } from './utils/needs_recompile.js';
import { run } from './utils/spawn.js';
import { warnIfAztecVersionMismatch } from './utils/warn_if_aztec_version_mismatch.js';

/** Where `aztec compile` writes artifacts, relative to the workspace root. */
const TARGET_DIR = 'target';
/** Where `aztec compile --unconstrained` writes artifacts, so that they never sit next to deployable ones. */
const UNCONSTRAINED_TARGET_DIR = join(TARGET_DIR, UNCONSTRAINED_BUILD_DIR);
const UNCONSTRAINED_FLAG = '--unconstrained';
/**
 * The nargo options of an unconstrained build. `--force-brillig`, a hidden nargo option, compiles every function as
 * unconstrained code. Without inlining, nargo compiles that code in time proportional to its size, where the default
 * inliner can take many minutes on large functions.
 */
const UNCONSTRAINED_NARGO_ARGS = ['--force-brillig', '--inliner-aggressiveness', '0'];
/** The nargo options that `--unconstrained` sets itself. */
const UNCONSTRAINED_NARGO_OPTIONS = ['--force-brillig', '--inliner-aggressiveness', '--target-dir'];

/** Returns contract artifacts in the target directory along with how far each has been postprocessed. */
async function collectContractArtifacts(targetDir: string): Promise<ContractArtifactInfo[]> {
  let files;
  try {
    files = await readArtifactFiles(targetDir);
  } catch (err: any) {
    if (err?.message?.includes('does not exist')) {
      return [];
    }
    throw err;
  }
  return files
    .filter(f => Array.isArray(f.content.functions))
    .map(f => ({
      filePath: f.filePath,
      transpiled: f.content.transpiled === true,
      unconstrained: f.content.unconstrained === true,
    }));
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

/**
 * Declares the functions of artifacts compiled as unconstrained code to be unconstrained, which nargo does not do for
 * private functions. bb generates verification keys for constrained private functions only, so these artifacts never
 * get any, and the class of a contract with a private function cannot be computed without them.
 *
 * With `complete`, also marks the artifacts as unconstrained builds, and removes any verification key of an artifact
 * that was postprocessed by other means.
 */
async function declareUnconstrained(artifactPaths: string[], { complete }: { complete: boolean }): Promise<void> {
  for (const path of artifactPaths) {
    const artifact: CompiledArtifact = JSON.parse(await readFile(path, 'utf-8'));
    for (const fn of artifact.functions) {
      // eslint-disable-next-line camelcase
      fn.is_unconstrained = true;
      if (complete) {
        delete fn.verification_key;
      }
    }
    if (complete) {
      artifact.unconstrained = true;
    }
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
 * Compiles Aztec Noir contracts and postprocesses artifacts. With `unconstrained`, private functions are compiled as
 * unconstrained code, which is much faster for large functions, and the artifacts are only usable in tests.
 */
async function compileAztecContract(nargoArgs: string[], unconstrained: boolean, log: LogFn): Promise<void> {
  await warnIfAztecVersionMismatch(log);

  const nargo = getEnv().NARGO ?? 'nargo';
  const bb = getEnv().BB ?? findBbBinary() ?? 'bb';
  const targetDir = unconstrained ? UNCONSTRAINED_TARGET_DIR : TARGET_DIR;
  if (unconstrained) {
    const conflicting = nargoArgs.find(arg => UNCONSTRAINED_NARGO_OPTIONS.some(option => arg.split('=')[0] === option));
    if (conflicting !== undefined) {
      throw new Error(`${conflicting} cannot be combined with ${UNCONSTRAINED_FLAG}, which sets it itself.`);
    }
  }

  const shouldRecompile = await needsRecompile(targetDir);
  if (shouldRecompile) {
    const modeArgs = unconstrained ? [...UNCONSTRAINED_NARGO_ARGS, '--target-dir', targetDir] : [];
    await run(nargo, ['compile', ...modeArgs, ...nargoArgs]);

    // Ensure contract crates contain no tests (tests belong in the test crate).
    await checkNoTestsInContracts(nargo, log);
  }

  // Postprocess any untranspiled artifacts: those just produced by nargo above, and any left behind by a bare
  // `nargo compile` run outside `aztec compile`.
  const artifacts = await collectContractArtifacts(targetDir);
  const unprocessed = artifacts.filter(a => !a.transpiled).map(a => a.filePath);

  if (unprocessed.length > 0) {
    log('Postprocessing contracts...');
    if (unconstrained) {
      await declareUnconstrained(unprocessed, { complete: false });
    }
    const bbArgs = unprocessed.flatMap(a => ['-i', a]);
    await run(bb, ['aztec_process', ...bbArgs]);

    await stampAztecVersion(unprocessed);
  }

  if (unconstrained) {
    // Marked last, as the transpiler does not keep the mark. An artifact left behind by an interrupted run is picked up
    // again here.
    const unmarked = artifacts.filter(a => !a.unconstrained).map(a => a.filePath);
    await declareUnconstrained(unmarked, { complete: true });
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
  /** Whether the artifact has already been marked as unconstrained and had its verification keys removed. */
  unconstrained: boolean;
}
