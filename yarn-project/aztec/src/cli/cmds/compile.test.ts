/* eslint-disable camelcase */
import { findBbBinary } from '@aztec-foundation/bb.js';

import { loadContractArtifact } from '@aztec-labs/stdlib/abi';
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import type { NoirCompiledContract } from '@aztec-labs/stdlib/noir';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
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

function runNargoCompile() {
  const nargo = process.env.NARGO ?? 'nargo';
  try {
    execFileSync(nargo, ['compile'], { cwd: WORKSPACE, stdio: 'pipe' });
  } catch (e: any) {
    throw new Error(`nargo compile failed:\n${e.stderr?.toString() ?? e.message}`);
  }
}

function runCodegen(artifacts = 'target') {
  try {
    execFileSync('node', [CLI, 'codegen', artifacts, '-o', 'codegen-output', '-f'], {
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
  const keyed = (artifact: NoirCompiledContract) => artifact.functions.filter(f => f.verification_key !== undefined);
  let unconstrained: NoirCompiledContract;

  beforeAll(() => {
    cleanupArtifacts();
    // The option follows an option of nargo, which must still reach nargo without it.
    runCompile(['--silence-warnings', '--unconstrained']);
    unconstrained = readArtifact(UNCONSTRAINED_TARGET);
  }, 120_000);

  afterAll(() => {
    cleanupArtifacts();
  });

  it('writes finished contract artifacts, and nothing else, to a directory of their own', () => {
    expect(readdirSync(TARGET)).toEqual(['unconstrained']);
    expect(readdirSync(UNCONSTRAINED_TARGET).sort()).toEqual(['.complete', ARTIFACT_NAME]);
  });

  it('does not compile again while the build is complete and up to date', () => {
    const modified = statSync(join(UNCONSTRAINED_TARGET, ARTIFACT_NAME)).mtimeMs;
    runCompile(['--unconstrained']);
    expect(statSync(join(UNCONSTRAINED_TARGET, ARTIFACT_NAME)).mtimeMs).toEqual(modified);
  });

  it('produces a transpiled, marked artifact without verification keys', () => {
    expect(unconstrained.transpiled).toBe(true);
    expect(unconstrained.unconstrained).toBe(true);
    expect(privateFunctions(unconstrained).length).toBeGreaterThan(0);
    expect(keyed(unconstrained)).toEqual([]);
  });

  it('produces an artifact that cannot be loaded, with or without its mark', () => {
    expect(() => loadContractArtifact(unconstrained)).toThrow(/can only be used in tests/);
    expect(() => loadContractArtifact({ ...unconstrained, unconstrained: false })).toThrow(/can only be used in tests/);
    expect(() => runCodegen(join('target', 'unconstrained', ARTIFACT_NAME))).toThrow(/can only be used in tests/);
  });

  it('produces an artifact without a contract class, even if nothing declares it unconstrained', async () => {
    const artifact = loadContractArtifact({
      ...unconstrained,
      unconstrained: false,
      functions: unconstrained.functions.map(fn => ({
        ...fn,
        is_unconstrained: !fn.custom_attributes.includes('abi_private'),
      })),
    });
    await expect(getContractClassFromArtifact(artifact)).rejects.toThrow(/must have a verification key/);
  });

  it('produces an artifact that gets no verification keys from being postprocessed again', () => {
    const copyDir = mkdtempSync(join(tmpdir(), 'unconstrained-artifact-'));
    try {
      copyFileSync(join(UNCONSTRAINED_TARGET, ARTIFACT_NAME), join(copyDir, ARTIFACT_NAME));
      const bb = process.env.BB ?? findBbBinary() ?? 'bb';
      execFileSync(bb, ['aztec_process', '-f', '-i', join(copyDir, ARTIFACT_NAME)], { stdio: 'pipe' });
      expect(keyed(readArtifact(copyDir))).toEqual([]);
    } finally {
      rmSync(copyDir, { recursive: true, force: true });
    }
  });

  it('compiles again a build that was not completed', () => {
    const modified = statSync(join(UNCONSTRAINED_TARGET, ARTIFACT_NAME)).mtimeMs;
    rmSync(join(UNCONSTRAINED_TARGET, '.complete'));

    runCompile(['--unconstrained']);

    expect(statSync(join(UNCONSTRAINED_TARGET, ARTIFACT_NAME)).mtimeMs).toBeGreaterThan(modified);
    expect(readArtifact(UNCONSTRAINED_TARGET)).toEqual(unconstrained);
    expect(readdirSync(UNCONSTRAINED_TARGET).sort()).toEqual(['.complete', ARTIFACT_NAME]);
  }, 120_000);

  it.each([['--target-dir', 'target'], ['--target-dir=target'], ['--force-brillig'], ['--inliner-aggressiveness=2']])(
    'rejects the nargo option it sets itself: %s',
    (...options) => {
      expect(() => runCompile(['--unconstrained', ...options])).toThrow(/cannot be combined/);
    },
  );

  it('leaves a regular build of the same contract next to it, the only one codegen finds', () => {
    runCompile();
    runCodegen();

    const regular = readArtifact(TARGET);
    expect(regular.unconstrained).toBeUndefined();
    expect(keyed(regular)).toHaveLength(privateFunctions(regular).length);
    expect(() => loadContractArtifact(regular)).not.toThrow();
    expect(readArtifact(UNCONSTRAINED_TARGET)).toEqual(unconstrained);
    expect(readFileSync(join(CODEGEN_OUT, 'SimpleContract.ts'), 'utf-8')).not.toContain('unconstrained');
  }, 120_000);
});

// The nargo options that compile private functions as unconstrained code would otherwise give an artifact that looks
// like a regular one and has verification keys.
describe('aztec compile with nargo options that compile unconstrained code', () => {
  afterAll(() => {
    cleanupArtifacts();
  });

  it.each(['--force-brillig', '--minimal-ssa'])('refuses %s without --unconstrained', option => {
    cleanupArtifacts();
    expect(() => runCompile([option])).toThrow(/Use --unconstrained/);
    expect(existsSync(TARGET)).toBe(false);
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
