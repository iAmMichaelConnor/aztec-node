import { omit } from '@aztec-labs/foundation/collection';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { ContractStore } from '@aztec-labs/pxe/client/lazy';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import type { NoirCompiledContract } from '@aztec-labs/stdlib/noir';
import { getPathToFixture } from '@aztec-labs/stdlib/testing/fixtures';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { TXEArtifactResolver } from './txe_artifact_resolver.js';

describe('TXEArtifactResolver', () => {
  let rootPath: string;
  let constrainedBuild: NoirCompiledContract;
  let unconstrainedBuild: NoirCompiledContract;

  const resolveToken = (resolver: TXEArtifactResolver) =>
    resolver.resolveDeployArtifact({
      rootPath,
      packageName: 'token_contract',
      contractPath: 'Token',
      initializer: '',
      args: [],
      secret: Fr.ZERO,
      salt: Fr.ONE,
      deployer: AztecAddress.ZERO,
      immutablesHash: Fr.ZERO,
    });

  const makeResolver = (unconstrained: boolean) => new TXEArtifactResolver({} as ContractStore, Fr.ZERO, unconstrained);

  const writeBuild = async (targetDir: string, build: NoirCompiledContract) => {
    await mkdir(join(rootPath, targetDir), { recursive: true });
    await writeFile(join(rootPath, targetDir, 'token_contract-Token.json'), JSON.stringify(build));
  };

  /** Writes a build as `aztec compile --unconstrained` leaves it once it has finished. */
  const writeCompleteUnconstrainedBuild = async (build: NoirCompiledContract) => {
    await writeBuild(join('target', 'unconstrained'), build);
    await writeFile(join(rootPath, 'target', 'unconstrained', '.complete'), '');
  };

  beforeAll(async () => {
    constrainedBuild = JSON.parse(await readFile(getPathToFixture('Token.test.json'), 'utf-8'));
    // What `aztec compile --unconstrained` leaves of an artifact: no verification keys, and the marker.
    unconstrainedBuild = {
      ...constrainedBuild,
      unconstrained: true,
      // eslint-disable-next-line camelcase
      functions: constrainedBuild.functions.map(fn => ({ ...omit(fn, 'verification_key'), is_unconstrained: true })),
    };
  });

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), 'txe-artifact-resolver-'));
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it('deploys an unconstrained build from its own target directory', async () => {
    await writeBuild('target', constrainedBuild);
    await writeCompleteUnconstrainedBuild(unconstrainedBuild);

    const constrained = await resolveToken(makeResolver(false));
    const unconstrained = await resolveToken(makeResolver(true));

    expect(unconstrained.artifact.name).toEqual('Token');
    expect(unconstrained.instance.address).not.toEqual(constrained.instance.address);
  });

  it('says how to compile a contract that has no unconstrained build', async () => {
    await writeBuild('target', constrainedBuild);

    await expect(resolveToken(makeResolver(true))).rejects.toThrow(/aztec compile --unconstrained/);
  });

  it('does not deploy from an unconstrained build that did not finish', async () => {
    await writeBuild(join('target', 'unconstrained'), unconstrainedBuild);

    await expect(resolveToken(makeResolver(true))).rejects.toThrow(/No complete unconstrained build/);
  });

  it('says how to compile a contract of another directory that has no unconstrained build', async () => {
    const deployment = resolveToken(makeResolver(true));
    const fromDirectory = makeResolver(true).resolveDeployArtifact({
      rootPath,
      packageName: 'token_test',
      contractPath: '../token_contract/Token',
      initializer: '',
      args: [],
      secret: Fr.ZERO,
      salt: Fr.ONE,
      deployer: AztecAddress.ZERO,
      immutablesHash: Fr.ZERO,
    });

    await expect(deployment).rejects.toThrow(/aztec compile --unconstrained/);
    await expect(fromDirectory).rejects.toThrow(/aztec compile --unconstrained/);
  });

  it('finds the unconstrained build of a contract of another package of the workspace', async () => {
    await writeCompleteUnconstrainedBuild(unconstrainedBuild);

    const { artifact } = await makeResolver(true).resolveDeployArtifact({
      rootPath,
      packageName: 'token_test',
      contractPath: '@token_contract/Token',
      initializer: '',
      args: [],
      secret: Fr.ZERO,
      salt: Fr.ONE,
      deployer: AztecAddress.ZERO,
      immutablesHash: Fr.ZERO,
    });

    expect(artifact.name).toEqual('Token');
  });

  it('does not deploy an unconstrained build unless asked to', async () => {
    await writeBuild('target', unconstrainedBuild);

    await expect(resolveToken(makeResolver(false))).rejects.toThrow(/can only be used in tests/);
  });

  it('does not deploy a constrained build in place of an unconstrained one', async () => {
    await writeCompleteUnconstrainedBuild(constrainedBuild);

    await expect(resolveToken(makeResolver(true))).rejects.toThrow(/is not an unconstrained build/);
  });
});
