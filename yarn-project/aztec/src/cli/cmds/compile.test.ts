/* eslint-disable camelcase */
import { findBbBinary } from '@aztec-foundation/bb.js';

import { loadContractArtifact } from '@aztec-labs/stdlib/abi';
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import type { NoirCompiledContract } from '@aztec-labs/stdlib/noir';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = join(PACKAGE_ROOT, 'dest/bin/index.js');
const WORKSPACE = join(PACKAGE_ROOT, 'test/mixed-workspace');
const TARGET = join(WORKSPACE, 'target');
const CODEGEN_OUT = join(WORKSPACE, 'codegen-output');

// Compiles a mixed workspace containing both a contract and a plain circuit,
// then runs codegen. Validates that:
// - Contract artifacts have a functions array and are transpiled
// - Program (circuit) artifacts do not have functions and are not transpiled
// - Codegen produces TypeScript only for contracts, not circuits
describe('aztec compile integration', () => {
  beforeAll(() => {
    cleanupArtifacts();
    runCompile();
    runCodegen();
  }, 120_000);

  afterAll(() => {
    cleanupArtifacts();
  });

  it('contract artifact has functions array', () => {
    const artifact = JSON.parse(readFileSync(join(TARGET, 'simple_contract-SimpleContract.json'), 'utf-8'));
    expect(Array.isArray(artifact.functions)).toBe(true);
    expect(artifact.functions.length).toBeGreaterThan(0);
  });

  it('program artifact does not have functions', () => {
    const artifact = JSON.parse(readFileSync(join(TARGET, 'simple_circuit.json'), 'utf-8'));
    expect(artifact.functions).toBeUndefined();
  });

  it('contract artifact was transpiled', () => {
    const artifact = JSON.parse(readFileSync(join(TARGET, 'simple_contract-SimpleContract.json'), 'utf-8'));
    expect(artifact.transpiled).toBe(true);
  });

  it('program artifact was not transpiled', () => {
    const artifact = JSON.parse(readFileSync(join(TARGET, 'simple_circuit.json'), 'utf-8'));
    expect(artifact.transpiled).toBeFalsy();
  });

  it('codegen produced TypeScript for contract', () => {
    expect(existsSync(join(CODEGEN_OUT, 'SimpleContract.ts'))).toBe(true);
  });

  it('codegen did not produce TypeScript for circuit', () => {
    expect(existsSync(join(CODEGEN_OUT, 'SimpleCircuit.ts'))).toBe(false);
  });
});

function cleanupArtifacts() {
  rmSync(TARGET, { recursive: true, force: true });
  rmSync(CODEGEN_OUT, { recursive: true, force: true });
  rmSync(join(WORKSPACE, 'codegenCache.json'), { force: true });
}

function runCompile(args: string[] = []) {
  try {
    execFileSync('node', [CLI, 'compile', ...args], { cwd: WORKSPACE, stdio: 'pipe' });
  } catch (e: any) {
    throw new Error(`compile failed:\n${e.stderr?.toString() ?? e.message}`);
  }
}

function runNargoCompile(args: string[] = []) {
  const nargo = process.env.NARGO ?? 'nargo';
  try {
    execFileSync(nargo, ['compile', ...args], { cwd: WORKSPACE, stdio: 'pipe' });
  } catch (e: any) {
    throw new Error(`nargo compile failed:\n${e.stderr?.toString() ?? e.message}`);
  }
}

function runCodegen(targetDir = 'target') {
  try {
    execFileSync('node', [CLI, 'codegen', targetDir, '-o', 'codegen-output', '-f'], {
      cwd: WORKSPACE,
      stdio: 'pipe',
    });
  } catch (e: any) {
    throw new Error(`codegen failed:\n${e.stderr?.toString() ?? e.message}`);
  }
}

// Regression test for https://github.com/AztecProtocol/aztec-packages/issues/24075: a bare `nargo compile` leaves
// untranspiled artifacts in target/. `aztec compile` must still postprocess them (transpile + generate VKs).
describe('aztec compile postprocesses pre-existing untranspiled artifacts', () => {
  const CONTRACT_ARTIFACT = join(TARGET, 'simple_contract-SimpleContract.json');

  beforeAll(() => {
    cleanupArtifacts();
    runNargoCompile();
  }, 120_000);

  afterAll(() => {
    cleanupArtifacts();
  });

  it('transpiles artifacts left untranspiled by a bare nargo compile', () => {
    const beforeAztecCompile = JSON.parse(readFileSync(CONTRACT_ARTIFACT, 'utf-8'));
    expect(beforeAztecCompile.transpiled).toBeFalsy();

    runCompile();
    const afterAztecCompile = JSON.parse(readFileSync(CONTRACT_ARTIFACT, 'utf-8'));
    expect(afterAztecCompile.transpiled).toBe(true);
  }, 120_000);
});

// An unconstrained build is fast to compile and enough for tests, but its private functions prove nothing, so it must
// be impossible to mistake for a deployable artifact or to turn into one.
describe('aztec compile --unconstrained', () => {
  const UNCONSTRAINED_TARGET = join(TARGET, 'unconstrained');
  const ARTIFACT_NAME = 'simple_contract-SimpleContract.json';
  const readArtifact = (dir: string): NoirCompiledContract =>
    JSON.parse(readFileSync(join(dir, ARTIFACT_NAME), 'utf-8'));
  const privateFunctions = (artifact: NoirCompiledContract) =>
    artifact.functions.filter(f => f.custom_attributes.includes('abi_private'));

  beforeAll(() => {
    cleanupArtifacts();
    runCompile(['--unconstrained']);
  }, 120_000);

  afterAll(() => {
    cleanupArtifacts();
  });

  it('writes artifacts to their own directory', () => {
    expect(readdirSync(UNCONSTRAINED_TARGET)).toContain(ARTIFACT_NAME);
    expect(readdirSync(TARGET)).toEqual(['unconstrained']);
  });

  it('produces a transpiled artifact without verification keys', () => {
    const artifact = readArtifact(UNCONSTRAINED_TARGET);
    expect(artifact.transpiled).toBe(true);
    expect(privateFunctions(artifact).length).toBeGreaterThan(0);
    expect(artifact.functions.filter(f => f.verification_key !== undefined)).toEqual([]);
  });

  it('produces an artifact that cannot be loaded', () => {
    expect(() => loadContractArtifact(readArtifact(UNCONSTRAINED_TARGET))).toThrow(/can only be used in tests/);
    expect(() => runCodegen('target/unconstrained/' + ARTIFACT_NAME)).toThrow(/can only be used in tests/);
  });

  it('produces an artifact that cannot be loaded even without its mark', () => {
    const unmarked = { ...readArtifact(UNCONSTRAINED_TARGET), unconstrained: false };
    expect(() => loadContractArtifact(unmarked)).toThrow(/can only be used in tests/);
  });

  it('produces an artifact without a contract class, even if nothing declares it unconstrained', async () => {
    const build = readArtifact(UNCONSTRAINED_TARGET);
    const artifact = loadContractArtifact({
      ...build,
      unconstrained: false,

      functions: build.functions.map(fn => ({
        ...fn,
        is_unconstrained: !fn.custom_attributes.includes('abi_private'),
      })),
    });
    await expect(getContractClassFromArtifact(artifact)).rejects.toThrow(/must have a verification key/);
  });

  it('produces an artifact that gets no verification keys from being postprocessed again', () => {
    const bb = process.env.BB ?? findBbBinary() ?? 'bb';
    execFileSync(bb, ['aztec_process', '-f', '-i', join(UNCONSTRAINED_TARGET, ARTIFACT_NAME)], { stdio: 'pipe' });

    const artifact = readArtifact(UNCONSTRAINED_TARGET);
    expect(artifact.functions.filter(f => f.verification_key !== undefined)).toEqual([]);
    expect(() => loadContractArtifact(artifact)).toThrow(/can only be used in tests/);
  });

  it('accepts the option after nargo options', () => {
    rmSync(UNCONSTRAINED_TARGET, { recursive: true, force: true });
    runCompile(['--silence-warnings', '--unconstrained']);

    expect(readArtifact(UNCONSTRAINED_TARGET).unconstrained).toBe(true);
  }, 120_000);

  it.each([['--target-dir', 'target'], ['--target-dir=target'], ['--force-brillig'], ['--inliner-aggressiveness=2']])(
    'rejects the nargo option it sets itself: %s',
    (...options) => {
      expect(() => runCompile(['--unconstrained', ...options])).toThrow(/cannot be combined/);
    },
  );

  it('completes an artifact that has been given verification keys', () => {
    const bb = process.env.BB ?? findBbBinary() ?? 'bb';
    rmSync(UNCONSTRAINED_TARGET, { recursive: true, force: true });
    runNargoCompile(['--force-brillig', '--target-dir', 'target/unconstrained']);
    execFileSync(bb, ['aztec_process', '-i', join(UNCONSTRAINED_TARGET, ARTIFACT_NAME)], { stdio: 'pipe' });
    expect(privateFunctions(readArtifact(UNCONSTRAINED_TARGET)).every(f => f.verification_key !== undefined)).toBe(
      true,
    );

    runCompile(['--unconstrained']);
    execFileSync(bb, ['aztec_process', '-f', '-i', join(UNCONSTRAINED_TARGET, ARTIFACT_NAME)], { stdio: 'pipe' });

    const artifact = readArtifact(UNCONSTRAINED_TARGET);
    expect(artifact.unconstrained).toBe(true);
    expect(artifact.functions.filter(f => f.verification_key !== undefined)).toEqual([]);
  }, 120_000);

  it('completes an artifact that nargo left in the directory', () => {
    rmSync(UNCONSTRAINED_TARGET, { recursive: true, force: true });
    runNargoCompile(['--force-brillig', '--target-dir', 'target/unconstrained']);
    runCompile(['--unconstrained']);

    const artifact = readArtifact(UNCONSTRAINED_TARGET);
    expect(artifact.unconstrained).toBe(true);
    expect(artifact.functions.filter(f => f.verification_key !== undefined)).toEqual([]);
  }, 120_000);

  it('leaves a deployable build of the same contract in place, which codegen still finds', () => {
    runCompile();
    runCompile(['--unconstrained']);

    const artifact = readArtifact(TARGET);
    expect(artifact.unconstrained).toBeUndefined();
    expect(privateFunctions(artifact).every(f => f.verification_key !== undefined)).toBe(true);
    expect(() => loadContractArtifact(artifact)).not.toThrow();

    runCodegen();
    expect(existsSync(join(CODEGEN_OUT, 'SimpleContract.ts'))).toBe(true);
  }, 120_000);
});

// `aztec test --package` compiles a package with the contracts it depends on, and reads which those are.
describe('aztec compile --package --with-contract-dependencies', () => {
  const artifacts = () =>
    readdirSync(TARGET)
      .filter(file => file.endsWith('.json'))
      .sort();
  const compileWithDependencies = (packageName: string) =>
    execFileSync('node', [CLI, 'compile', '--package', packageName, '--with-contract-dependencies'], {
      cwd: WORKSPACE,
      stdio: 'pipe',
      encoding: 'utf-8',
    });

  beforeEach(() => {
    cleanupArtifacts();
  });

  afterAll(() => {
    cleanupArtifacts();
  });

  it('compiles the selected contract and prints the contracts it covers', () => {
    expect(compileWithDependencies('simple_contract')).toEqual('simple_contract\n');
    expect(artifacts()).toEqual(['simple_contract-SimpleContract.json']);
  }, 120_000);

  it('compiles a binary that depends on no contract, and prints no contract', () => {
    expect(compileWithDependencies('simple_circuit')).toEqual('');
    expect(artifacts()).toEqual(['simple_circuit.json']);
  }, 120_000);

  it('does not compile the package again while it is up to date', () => {
    compileWithDependencies('simple_contract');
    const modified = statSync(join(TARGET, 'simple_contract-SimpleContract.json')).mtimeMs;

    expect(compileWithDependencies('simple_contract')).toEqual('simple_contract\n');
    expect(statSync(join(TARGET, 'simple_contract-SimpleContract.json')).mtimeMs).toEqual(modified);
  }, 120_000);

  it('leaves the rest of the workspace for a later compilation', () => {
    compileWithDependencies('simple_circuit');
    runCompile();
    expect(artifacts()).toEqual([
      'simple_circuit.json',
      'simple_circuit_2.json',
      'simple_contract-SimpleContract.json',
    ]);
  }, 120_000);

  it('needs a package of the workspace', () => {
    expect(() =>
      execFileSync('node', [CLI, 'compile', '--with-contract-dependencies'], { cwd: WORKSPACE, stdio: 'pipe' }),
    ).toThrow(/needs a single package/);
    expect(() => compileWithDependencies('missing')).toThrow(/not a member of a workspace/);
  });
});

// Validates that aztec compile warns when contract crates contain tests. We want tests to be in a separate `lib` crate.
describe('aztec compile warns about tests in contract crates', () => {
  const CONTRACT_WITH_TESTS_WORKSPACE = join(PACKAGE_ROOT, 'test/contract-with-tests');
  const CONTRACT_WITH_TESTS_TARGET = join(CONTRACT_WITH_TESTS_WORKSPACE, 'target');

  afterAll(() => {
    rmSync(CONTRACT_WITH_TESTS_TARGET, { recursive: true, force: true });
  });

  it('warns when a contract crate contains tests', () => {
    const result = execFileSync('node', [CLI, 'compile'], {
      cwd: CONTRACT_WITH_TESTS_WORKSPACE,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    expect(result).toMatch(/Found tests in contract crate/);
  }, 120_000);
});
