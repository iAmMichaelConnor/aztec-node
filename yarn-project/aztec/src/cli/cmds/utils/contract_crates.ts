import { compactArray } from '@aztec-labs/foundation/collection';
import TOML from '@iarna/toml';
import { readFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';

import { collectCrateDirs } from './collect_crate_dirs.js';

/** A crate that nargo compiles into artifacts of its own: a contract or a binary. */
export interface CompilableCrate {
  name: string;
  dir: string;
  type: 'contract' | 'bin';
}

/** The parts of a Nargo.toml that tell which crates a compilation covers. */
interface NargoManifest {
  workspace?: { members?: string[]; 'default-member'?: string };
  package?: { name?: string; type?: string };
}

/** A package of the workspace. */
interface WorkspaceMember {
  dir: string;
  manifest: NargoManifest;
}

async function readManifest(crateDir: string): Promise<NargoManifest> {
  return TOML.parse(await readFile(join(crateDir, 'Nargo.toml'), 'utf-8'));
}

/**
 * Returns the packages of the workspace, or the single package if there is no workspace. With `defaultOnly`, returns
 * the packages that nargo selects when none is named: the default member if the workspace declares one.
 */
async function getWorkspaceMembers(workspaceDir: string, defaultOnly = false): Promise<WorkspaceMember[]> {
  const root = await readManifest(workspaceDir);
  const defaultMember = defaultOnly ? root.workspace?.['default-member'] : undefined;
  const allMembers = root.workspace?.members;
  const memberPaths = defaultMember !== undefined ? [defaultMember] : Array.isArray(allMembers) ? allMembers : ['.'];
  const members: WorkspaceMember[] = [];
  for (const memberPath of memberPaths) {
    const dir = resolve(workspaceDir, memberPath);
    members.push({ dir, manifest: await readManifest(dir) });
  }
  return members;
}

function toCompilableCrate({ dir, manifest }: WorkspaceMember): CompilableCrate | undefined {
  const { name, type } = manifest.package ?? {};
  return name !== undefined && (type === 'contract' || type === 'bin') ? { name, dir, type } : undefined;
}

/** Returns the contracts and binaries that nargo compiles when no package is selected. */
export async function collectDefaultCrates(workspaceDir = '.'): Promise<CompilableCrate[]> {
  const members = await getWorkspaceMembers(workspaceDir, true);
  return compactArray(members.map(toCompilableCrate));
}

/** Returns whether a directory above the given one holds the manifest of a workspace. */
async function isInsideWorkspace(dir: string): Promise<boolean> {
  for (let parent = dirname(resolve(dir)); parent !== dirname(parent); parent = dirname(parent)) {
    const manifest = await readFile(join(parent, 'Nargo.toml'), 'utf-8').catch(() => undefined);
    if (manifest !== undefined && (TOML.parse(manifest) as NargoManifest).workspace !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the crates to compile for a package of the workspace: the package itself if it is a contract or a binary,
 * and the contracts of the workspace that it depends on through path dependencies, directly or not.
 *
 * Returns undefined if `workspaceDir` is not where nargo roots the package's workspace: the package is not one of its
 * members, or the directory is itself inside a workspace.
 */
export async function collectCratesToCompile(
  packageName: string,
  workspaceDir = '.',
): Promise<CompilableCrate[] | undefined> {
  const members = await getWorkspaceMembers(workspaceDir);
  const selected = members.find(member => member.manifest.package?.name === packageName);
  if (selected === undefined || (await isInsideWorkspace(workspaceDir))) {
    return undefined;
  }

  // nargo only compiles members of the workspace, so contracts that are dependencies from elsewhere are left out.
  const dependencyDirs = new Set(await collectCrateDirs(selected.dir, { skipGitDeps: true }));
  return compactArray(
    members
      .filter(member => member === selected || dependencyDirs.has(member.dir))
      .map(toCompilableCrate)
      .filter(crate => crate?.type === 'contract' || crate?.dir === selected.dir),
  );
}

const PACKAGE_FLAG = '--package';

/**
 * Splits the package selected with nargo's `--package` option, if any, from the rest of the arguments. Arguments that
 * nargo rejects, or that select the whole workspace, are left as they are for nargo to handle.
 */
export function extractPackage(nargoArgs: string[]): { packageName?: string; otherArgs: string[] } {
  const isPackageFlag = (arg: string) => arg === PACKAGE_FLAG || arg.startsWith(`${PACKAGE_FLAG}=`);
  const index = nargoArgs.findIndex(isPackageFlag);
  const inline = index !== -1 && nargoArgs[index] !== PACKAGE_FLAG;
  const packageName = inline ? nargoArgs[index].slice(PACKAGE_FLAG.length + 1) : nargoArgs[index + 1];
  if (
    index === -1 ||
    !packageName ||
    packageName.startsWith('-') ||
    nargoArgs.filter(isPackageFlag).length > 1 ||
    nargoArgs.includes('--workspace')
  ) {
    return { otherArgs: nargoArgs };
  }
  return { packageName, otherArgs: nargoArgs.toSpliced(index, inline ? 1 : 2) };
}
