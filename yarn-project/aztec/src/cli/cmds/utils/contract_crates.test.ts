import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { collectCratesToCompile, collectDefaultCrates, extractPackage } from './contract_crates.js';

describe('crates to compile', () => {
  let root: string;
  let workspace: string;

  const makePackage = async (dir: string, name: string, type: string, deps: Record<string, string> = {}) => {
    await mkdir(join(dir, name), { recursive: true });
    const dependencies = Object.entries(deps)
      .map(([dep, path]) => `${dep} = { path = "${path}" }`)
      .join('\n');
    await writeFile(
      join(dir, name, 'Nargo.toml'),
      `[package]\nname = "${name}"\ntype = "${type}"\n\n[dependencies]\n${dependencies}\n`,
    );
  };

  const makeWorkspace = (members: string[], defaultMember?: string) =>
    writeFile(
      join(workspace, 'Nargo.toml'),
      `[workspace]\nmembers = [${members.map(m => `"${m}"`).join(', ')}]\n` +
        (defaultMember ? `default-member = "${defaultMember}"\n` : ''),
    );

  const members = ['math', 'token', 'amm', 'amm_test', 'nft', 'nft_test', 'math_test', 'circuit'];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crates-to-compile-'));
    workspace = join(root, 'workspace');
    // token <- amm <- amm_test, an unrelated contract with its own tests, a binary, and a contract from elsewhere that
    // token depends on for its interface.
    await makePackage(root, 'registry', 'contract');
    await makePackage(workspace, 'math', 'lib');
    await makePackage(workspace, 'token', 'contract', {
      math: '../math',
      registry: '../../registry',
    });
    await makePackage(workspace, 'amm', 'contract', { token: '../token', math: '../math' });
    await makePackage(workspace, 'amm_test', 'lib', { amm: '../amm' });
    await makePackage(workspace, 'nft', 'contract');
    await makePackage(workspace, 'nft_test', 'lib', { nft: '../nft' });
    await makePackage(workspace, 'math_test', 'lib', { math: '../math' });
    await makePackage(workspace, 'circuit', 'bin', { math: '../math' });
    await makeWorkspace(members);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const names = (crates: { name: string }[]) => crates.map(crate => crate.name).sort();

  describe('collectCratesToCompile', () => {
    const select = async (packageName: string, dir = workspace) => {
      const crates = await collectCratesToCompile(packageName, dir);
      return crates && names(crates);
    };

    it('selects the contracts a test crate depends on, directly or not', async () => {
      expect(await select('amm_test')).toEqual(['amm', 'token']);
    });

    it('selects the package itself if it is a contract', async () => {
      expect(await select('amm')).toEqual(['amm', 'token']);
    });

    it('selects only the package itself if it is a binary', async () => {
      expect(await select('circuit')).toEqual(['circuit']);
    });

    it('selects nothing for a package that depends on no contract', async () => {
      expect(await select('math_test')).toEqual([]);
    });

    it('leaves out contracts that are not part of the workspace', async () => {
      expect(await select('token')).toEqual(['token']);
    });

    it('gives the directory and kind of each crate', async () => {
      expect(await collectCratesToCompile('nft_test', workspace)).toEqual([
        { name: 'nft', dir: join(workspace, 'nft'), type: 'contract' },
      ]);
    });

    it('does not answer for a package that is not a member of the workspace', async () => {
      expect(await select('missing')).toBeUndefined();
    });

    it('does not answer from the directory of a member, where nargo still uses the workspace', async () => {
      expect(await select('nft', join(workspace, 'nft'))).toBeUndefined();
    });

    it('handles a single package without a workspace', async () => {
      expect(await select('registry', join(root, 'registry'))).toEqual(['registry']);
    });
  });

  describe('extractPackage', () => {
    it('takes a single package out of the arguments', () => {
      expect(extractPackage(['--silence-warnings', '--package', 'amm', '--force'])).toEqual({
        packageName: 'amm',
        otherArgs: ['--silence-warnings', '--force'],
      });
      expect(extractPackage(['--package=amm', '--force'])).toEqual({ packageName: 'amm', otherArgs: ['--force'] });
    });

    it.each([
      [['--force']],
      [['--package']],
      [['--package=']],
      [['--package', '--force']],
      [['--package', 'amm', '--package', 'nft']],
      [['--package', 'amm', '--workspace']],
    ])('leaves %j to nargo', args => {
      expect(extractPackage(args)).toEqual({ otherArgs: args });
    });
  });

  describe('collectDefaultCrates', () => {
    it('returns the contracts and binaries among the workspace members', async () => {
      expect(names(await collectDefaultCrates(workspace))).toEqual(['amm', 'circuit', 'nft', 'token']);
    });

    it('returns only the default member of a workspace that declares one', async () => {
      await makeWorkspace(members, 'nft');
      expect(names(await collectDefaultCrates(workspace))).toEqual(['nft']);
    });
  });
});
