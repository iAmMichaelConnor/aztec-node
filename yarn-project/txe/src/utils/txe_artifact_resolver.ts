import { MEGA_APP_VK_LENGTH_IN_FIELDS } from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { createLogger } from '@aztec-labs/foundation/log';
import type { ContractStore } from '@aztec-labs/pxe/client/lazy';
import { type ContractArtifact, loadContractArtifact } from '@aztec-labs/stdlib/abi';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import {
  type ContractArtifactWithHash,
  type ContractInstanceWithAddress,
  computeArtifactHash,
  getContractInstanceFromInstantiationParams,
} from '@aztec-labs/stdlib/contract';
import { PublicKeys, deriveKeys } from '@aztec-labs/stdlib/keys';
import {
  AZTEC_PRIVATE_ATTRIBUTE,
  type NoirCompiledContract,
  UNCONSTRAINED_BUILD_DIR,
  isUnconstrainedBuild,
} from '@aztec-labs/stdlib/noir';
import { Buffer } from 'buffer';
import { createHash } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { join, parse } from 'path';

/** Where `aztec compile` writes artifacts, relative to a workspace root. */
const TARGET_DIR = 'target';
/** Where `aztec compile --unconstrained` writes artifacts, relative to a workspace root. */
const UNCONSTRAINED_TARGET_DIR = join(TARGET_DIR, UNCONSTRAINED_BUILD_DIR);

export interface ResolvedArtifact {
  artifact: ContractArtifactWithHash;
  instance: ContractInstanceWithAddress;
}

/**
 * Cache + in-flight map pair. Lookup hits the cache, then awaits an in-flight `compute()` if one
 * exists, otherwise starts one and stores it. Guarantees `compute()` runs at most once per `key`
 * across concurrent callers, which matters because `computeArtifactHash` is expensive.
 */
class AsyncCache<K, V> {
  #cache = new Map<K, V>();
  #inFlight = new Map<K, Promise<V>>();

  getOrCompute(key: K, compute: () => Promise<V>): Promise<V> {
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    let pending = this.#inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const value = await compute();
          this.#cache.set(key, value);
          return value;
        } finally {
          this.#inFlight.delete(key);
        }
      })();
      this.#inFlight.set(key, pending);
    }
    return pending;
  }
}

/**
 * Resolves and caches contract artifacts and their associated instances.
 *
 * Artifact hash computation is expensive, so this service deduplicates both completed and in-flight computations.
 * Two cache levels are kept: full deploys (artifact + computed instance) keyed by the full deploy context, and loaded +
 * hashed artifacts keyed by the compiled-bytecode hash so deploys of the same contract with different args / salt /
 * deployer reuse the same `ContractArtifactWithHash`.
 *
 * With `unconstrained` set, contracts are loaded from the unconstrained builds that `aztec compile --unconstrained`
 * produces, and only from those.
 */
export class TXEArtifactResolver {
  #deployments = new AsyncCache<string, ResolvedArtifact>();
  #artifacts = new AsyncCache<string, ContractArtifactWithHash>();
  #logger = createLogger('txe:artifact_resolver');

  constructor(
    private readonly contractStore: ContractStore,
    private readonly schnorrClassId: Fr,
    private readonly unconstrained = false,
  ) {}

  /** Resolves the Schnorr account contract artifact and instance for the given secret, caching the result. */
  resolveAccountArtifact(secret: Fr): Promise<ResolvedArtifact> {
    return this.#deployments.getOrCompute(`SchnorrAccountContract-${secret}`, () =>
      this.#computeAccountArtifact(secret),
    );
  }

  /** Resolves a contract artifact from disk by path, computes its instance, and caches the result. */
  async resolveDeployArtifact({
    rootPath,
    packageName,
    contractPath,
    initializer,
    args,
    secret,
    salt,
    deployer,
    immutablesHash,
  }: {
    rootPath: string;
    packageName: string;
    contractPath: string;
    initializer: string;
    args: Fr[];
    secret: Fr;
    salt: Fr;
    deployer: AztecAddress;
    immutablesHash: Fr;
  }): Promise<ResolvedArtifact> {
    const publicKeys = secret.equals(Fr.ZERO) ? PublicKeys.default() : (await deriveKeys(secret)).publicKeys;
    const publicKeysHash = await publicKeys.hash();

    const artifactPath = await this.#resolveArtifactPath(rootPath, packageName, contractPath);
    if (!existsSync(artifactPath)) {
      const compileCommand = this.unconstrained ? 'aztec compile --unconstrained' : 'aztec compile';
      throw new Error(`Contract artifact ${artifactPath} not found. Compile its workspace with \`${compileCommand}\`.`);
    }
    const fileHash = await this.#fastHashFile(artifactPath);

    const { dir: contractDirectory, base: contractFilename } = parse(contractPath);
    const cacheKey = `${contractDirectory ?? ''}-${contractFilename}-${initializer}-${args
      .map(arg => arg.toString())
      .join('-')}-${publicKeysHash}-${salt}-${deployer}-${immutablesHash}-${fileHash}`;

    return this.#deployments.getOrCompute(cacheKey, () =>
      this.#computeDeployArtifact(
        artifactPath,
        fileHash,
        initializer,
        args,
        salt,
        publicKeys,
        publicKeysHash,
        deployer,
        immutablesHash,
      ),
    );
  }

  async #resolveArtifactPath(rootPath: string, packageName: string, contractPath: string): Promise<string> {
    const { dir: contractDirectory, base: contractFilename } = parse(contractPath);
    const targetDir = this.unconstrained ? UNCONSTRAINED_TARGET_DIR : TARGET_DIR;
    if (contractDirectory) {
      if (contractDirectory.includes('@')) {
        // env.deploy("../path/to/workspace/root@packageName/contractName")
        const [workspace, pkg] = contractDirectory.split('@');
        const targetPath = join(rootPath, workspace, targetDir);
        this.#logger.debug(`Looking for compiled artifact in workspace ${targetPath}`);
        return join(targetPath, `${pkg}-${contractFilename}.json`);
      } else {
        // env.deploy("../path/to/contract/root/contractName")
        const targetPath = join(rootPath, contractDirectory, targetDir);
        this.#logger.debug(`Looking for compiled artifact in ${targetPath}`);
        const files = existsSync(targetPath) ? await readdir(targetPath) : [];
        const fileName = files.find(file => file.endsWith(`-${contractFilename}.json`));
        return join(targetPath, fileName ?? `*-${contractFilename}.json`);
      }
    } else {
      // env.deploy("contractName")
      return join(rootPath, targetDir, `${packageName}-${contractFilename}.json`);
    }
  }

  async #computeAccountArtifact(secret: Fr): Promise<ResolvedArtifact> {
    const [artifactFromStore, classWithPreimage] = await Promise.all([
      this.contractStore.getContractArtifact(this.schnorrClassId),
      this.contractStore.getContractClassWithPreimage(this.schnorrClassId),
    ]);
    if (!artifactFromStore || !classWithPreimage) {
      throw new Error(
        `SchnorrAccount not found in shared contract store at class id ${this.schnorrClassId.toString()}`,
      );
    }
    const artifact: ContractArtifactWithHash = { ...artifactFromStore, artifactHash: classWithPreimage.artifactHash };
    const keys = await deriveKeys(secret);
    const args = [keys.publicKeys.ivpkM.x, keys.publicKeys.ivpkM.y];
    const instance = await getContractInstanceFromInstantiationParams(artifact, {
      constructorArgs: args,
      skipArgsDecoding: true,
      salt: Fr.ONE,
      publicKeys: keys.publicKeys,
      constructorArtifact: 'constructor',
      deployer: AztecAddress.ZERO,
    });
    return { artifact, instance };
  }

  async #computeDeployArtifact(
    artifactPath: string,
    fileHash: string,
    initializer: string,
    args: Fr[],
    salt: Fr,
    publicKeys: PublicKeys,
    publicKeysHash: Fr,
    deployer: AztecAddress,
    immutablesHash: Fr,
  ): Promise<ResolvedArtifact> {
    // Inner cache: artifact load + hash depends only on the compiled bytecode (`fileHash`), so subsequent deploys of
    // the same contract — regardless of constructor args / deployer / salt — reuse the same `ContractArtifactWithHash`.
    const artifact = await this.#artifacts.getOrCompute(fileHash, async () => {
      this.#logger.debug(`Loading compiled artifact ${artifactPath}`);
      const artifactJSON = JSON.parse(await readFile(artifactPath, 'utf-8')) as NoirCompiledContract;
      const artifactWithoutHash = this.unconstrained
        ? loadUnconstrainedBuild(artifactJSON, artifactPath)
        : loadContractArtifact(artifactJSON);
      return { ...artifactWithoutHash, artifactHash: await computeArtifactHash(artifactWithoutHash) };
    });
    this.#logger.debug(
      `Deploy ${artifact.name} with initializer ${initializer}(${args}) and public keys hash ${publicKeysHash}`,
    );
    const instance = await getContractInstanceFromInstantiationParams(artifact, {
      constructorArgs: args,
      skipArgsDecoding: true,
      salt,
      publicKeys,
      constructorArtifact: initializer || undefined,
      deployer,
      immutablesHash,
    });
    return { artifact, instance };
  }

  #fastHashFile(path: string): Promise<string> {
    return new Promise(resolve => {
      const fd = createReadStream(path);
      const hash = createHash('sha1');
      hash.setEncoding('hex');

      fd.on('end', function () {
        hash.end();
        resolve(hash.read() as string);
      });

      fd.pipe(hash);
    });
  }
}

/**
 * Loads an unconstrained build, which has no verification keys and which `loadContractArtifact` rejects so that it is
 * never deployed. The TXE executes private functions without proving them, so it gives each one a placeholder key to
 * compute the contract class from.
 */
function loadUnconstrainedBuild(contract: NoirCompiledContract, artifactPath: string): ContractArtifact {
  if (!isUnconstrainedBuild(contract)) {
    throw new Error(
      `${artifactPath} is not an unconstrained build. Compile the contract with \`aztec compile --unconstrained\`.`,
    );
  }
  const placeholderKey = Buffer.alloc(MEGA_APP_VK_LENGTH_IN_FIELDS * Fr.SIZE_IN_BYTES).toString('base64');
  return loadContractArtifact({
    ...contract,
    unconstrained: false,
    functions: contract.functions.map(fn =>
      fn.custom_attributes.includes(AZTEC_PRIVATE_ATTRIBUTE)
        ? // eslint-disable-next-line camelcase
          { ...fn, is_unconstrained: false, verification_key: placeholderKey }
        : fn,
    ),
  });
}
