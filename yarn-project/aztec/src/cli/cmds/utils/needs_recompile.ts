import { readdir, stat } from 'fs/promises';
import { join } from 'path';

import { collectCrateDirs } from './collect_crate_dirs.js';
import type { CompilableCrate } from './contract_crates.js';

/**
 * Returns true if recompilation is needed: either no artifacts exist in targetDir or any .nr or Nargo.toml source file
 * (including path-based dependencies) is newer than the oldest artifact. We compare against the oldest artifact so
 * that a source change between the oldest and newest compilation (e.g. in a multi-contract workspace) still triggers
 * a recompile.
 *
 * Note: The above implies that if there is a random json file in the target dir we would be always recompiling.
 *
 * With `crate`, only that crate is considered: its own artifacts, and its sources and those of its dependencies.
 */
export async function needsRecompile(targetDir = 'target', crate?: CompilableCrate): Promise<boolean> {
  const oldestArtifactMs = await getOldestArtifactModificationTime(targetDir, crate);
  if (oldestArtifactMs === undefined) {
    return true;
  }

  // Git deps are pinned to a specific tag in Nargo.toml and nargo always fetches an exact tag, so their contents never
  // change without Nargo.toml itself changing — and Nargo.toml is already tracked as a source file. Hence we can
  // safely ignore checking source files of git deps.
  const crateDirs = await collectCrateDirs(crate?.dir ?? '.', { skipGitDeps: true });
  return hasNewerSourceFile(crateDirs, oldestArtifactMs);
}

/** Returns true if the target directory holds an artifact of the crate. */
export async function hasArtifacts(targetDir: string, crate: CompilableCrate): Promise<boolean> {
  return (await getOldestArtifactModificationTime(targetDir, crate)) !== undefined;
}

/** Returns true if the file is an artifact of the crate: `<package>-<contract>.json` or `<package>.json`. */
function isArtifactOf(file: string, crate: CompilableCrate): boolean {
  return crate.type === 'contract' ? file.startsWith(`${crate.name}-`) : file === `${crate.name}.json`;
}

/**
 * Returns the last modification time (timestamp in ms) of the oldest .json artifact in targetDir, or undefined if
 * none exist. With `crate`, only the artifacts of that crate count.
 */
async function getOldestArtifactModificationTime(
  targetDir: string,
  crate?: CompilableCrate,
): Promise<number | undefined> {
  let entries: string[];
  try {
    entries = (await readdir(targetDir)).filter(
      f => f.endsWith('.json') && (crate === undefined || isArtifactOf(f, crate)),
    );
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }

  if (entries.length === 0) {
    return undefined;
  }

  let oldest = Infinity;
  for (const entry of entries) {
    const s = await stat(join(targetDir, entry));
    if (s.mtimeMs < oldest) {
      oldest = s.mtimeMs;
    }
  }
  return oldest;
}

/**
 * Walks crate dirs looking for .nr and Nargo.toml files newer than thresholdMs. Short-circuits on the first match.
 */
async function hasNewerSourceFile(crateDirs: string[], thresholdMs: number): Promise<boolean> {
  // Returns true if it find a new file than thresholdMs, false otherwise
  async function walkForNewer(dir: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    // We iterate over the entries in the dir
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // If the entry is a dir and it's not called `target` we recursively enter it
        if (entry.name === 'target') {
          continue;
        }
        if (await walkForNewer(fullPath)) {
          return true;
        }
      } else if (entry.name === 'Nargo.toml' || entry.name.endsWith('.nr')) {
        // The entry is a Nargo.toml file or *.nr file so we check the timestamp
        const s = await stat(fullPath);
        if (s.mtimeMs > thresholdMs) {
          return true;
        }
      }
    }
    return false;
  }

  // We search through the crate dirs
  for (const dir of crateDirs) {
    if (await walkForNewer(dir)) {
      return true;
    }
  }
  return false;
}
