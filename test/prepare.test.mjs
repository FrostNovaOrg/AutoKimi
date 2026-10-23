import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareSource } from '../tools/prepare.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'autokimi-source-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'official');
  const repo = join(root, 'overlay-repo');
  const git = (...args) =>
    execFileSync('git', ['-C', source, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  await mkdir(join(source, 'apps', 'kimi-code'), { recursive: true });
  await mkdir(join(repo, 'overlay', 'src'), { recursive: true });
  await mkdir(join(repo, 'patches'));
  await writeFile(
    join(source, 'apps', 'kimi-code', 'package.json'),
    '{"version":"2.3.0"}\n',
  );
  await writeFile(join(source, 'existing.txt'), 'original\n');
  git('init', '--initial-branch=main');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'fixture',
  );
  const commit = git('rev-parse', 'HEAD');
  await writeFile(
    join(repo, 'upstream.lock.json'),
    JSON.stringify({
      commit,
      version: '2.3.0',
      repository: 'https://example.invalid/official.git',
      patches: ['patches/change.patch'],
    }),
  );
  await writeFile(join(source, 'existing.txt'), 'patched\n');
  await writeFile(join(repo, 'patches', 'change.patch'), git('diff') + '\n');
  git('checkout', '--', 'existing.txt');
  await writeFile(join(repo, 'overlay', 'src', 'new.txt'), 'reviewer\n');
  return {
    root: repo,
    source,
    worktree: join(repo, '.cache', 'kimi-code'),
    git,
  };
}

test('prepares the exact commit, applies both source forms and reuses an intact cache', async (t) => {
  const options = await fixture(t);
  await writeFile(
    join(options.source, 'existing.txt'),
    'uncommitted source edit\n',
  );
  await prepareSource(options);
  assert.equal(
    await readFile(join(options.worktree, 'existing.txt'), 'utf8'),
    'patched\n',
  );
  assert.equal(
    await readFile(join(options.worktree, 'src', 'new.txt'), 'utf8'),
    'reviewer\n',
  );
  assert.equal(
    await readFile(join(options.source, 'existing.txt'), 'utf8'),
    'uncommitted source edit\n',
  );
  const before = await readFile(
    join(options.worktree, '.autokimi-source.json'),
    'utf8',
  );
  assert.equal(await prepareSource(options), options.worktree);
  assert.equal(
    await readFile(join(options.worktree, '.autokimi-source.json'), 'utf8'),
    before,
  );
});

test('refuses edited cached sources instead of overwriting them', async (t) => {
  const options = await fixture(t);
  await prepareSource(options);
  await writeFile(join(options.worktree, 'src', 'new.txt'), 'keep my edit\n');
  await assert.rejects(prepareSource(options), /local edits/);
  assert.equal(
    await readFile(join(options.worktree, 'src', 'new.txt'), 'utf8'),
    'keep my edit\n',
  );
});

test('refuses stale inputs and unowned destinations', async (t) => {
  const options = await fixture(t);
  await prepareSource(options);
  await writeFile(
    join(options.root, 'overlay', 'src', 'new.txt'),
    'new overlay\n',
  );
  await assert.rejects(prepareSource(options), /Overlay changed/);
  const other = join(options.root, 'unowned');
  await mkdir(other);
  await assert.rejects(
    prepareSource({ ...options, worktree: other }),
    /not an AutoKimi worktree/,
  );
});

test('rejects overlay collisions and removes incomplete staging', async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.root, 'overlay', 'existing.txt'), 'collision\n');
  await assert.rejects(prepareSource(options), /overwrite an existing file/);
  assert.equal(existsSync(options.worktree), false);
  assert.deepEqual(await readdir(join(options.root, '.cache')), []);
});

test('invalid patches leave upstream and destination untouched', async (t) => {
  const options = await fixture(t);
  await writeFile(
    join(options.root, 'patches', 'change.patch'),
    'invalid patch\n',
  );
  await assert.rejects(prepareSource(options));
  assert.equal(existsSync(options.worktree), false);
  assert.equal(
    await readFile(join(options.source, 'existing.txt'), 'utf8'),
    'original\n',
  );
  assert.deepEqual(await readdir(join(options.root, '.cache')), []);
});
