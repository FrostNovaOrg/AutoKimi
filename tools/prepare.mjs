import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  filesUnder,
  isMain,
  projectRoot,
  readJson,
  readUpstreamLock,
  run,
  sha256,
} from './common.mjs';

function git(cwd, args) {
  return run('git', ['-C', cwd, ...args], { capture: true });
}

async function sourceState(worktree) {
  const untracked = git(worktree, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  const content = [git(worktree, ['diff', 'HEAD', '--binary'])];
  for (const path of untracked)
    content.push(path, sha256(await readFile(join(worktree, path))));
  return sha256(content.join('\0'));
}

async function sourceInputs(root, lock) {
  const overlay = join(root, 'overlay');
  const files = await filesUnder(overlay);
  const inputs = [JSON.stringify(lock)];
  for (const patch of lock.patches) {
    assert.ok(patch.startsWith('patches/') && !patch.split('/').includes('..'));
    inputs.push(patch, sha256(await readFile(join(root, patch))));
  }
  for (const path of files)
    inputs.push(path, sha256(await readFile(join(overlay, path))));
  return { inputHash: sha256(inputs.join('\0')), files };
}

export async function verifyPreparedSource(options = {}) {
  const root = resolve(options.root || projectRoot);
  const worktree = resolve(
    options.worktree || join(root, '.cache', 'kimi-code'),
  );
  const lock = await readUpstreamLock(root, options.lock);
  const marker = await readJson(
    join(worktree, '.autokimi-source.json'),
  ).catch(() => undefined);
  assert.ok(
    marker,
    'Existing destination is not an AutoKimi worktree. Choose a new --worktree.',
  );
  assert.equal(
    git(worktree, ['rev-parse', 'HEAD']),
    lock.commit,
    'Cached upstream HEAD changed.',
  );
  assert.equal(
    await sourceState(worktree),
    marker.sourceState,
    'Cached sources have local edits; preserve them before recreating the cache.',
  );
  assert.equal(
    marker.inputHash,
    (await sourceInputs(root, lock)).inputHash,
    'Overlay changed. Preserve any cache edits, then remove .cache/kimi-code and prepare again.',
  );
  return worktree;
}

export async function prepareSource(options = {}) {
  const root = resolve(options.root || projectRoot);
  const worktree = resolve(
    options.worktree || join(root, '.cache', 'kimi-code'),
  );
  const lock = await readUpstreamLock(root, options.lock);
  const { inputHash, files } = await sourceInputs(root, lock);
  const markerName = '.autokimi-source.json';
  if (existsSync(worktree))
    return verifyPreparedSource({ root, worktree, lock });
  const staging = worktree + '.prepare-' + randomUUID();
  await mkdir(dirname(worktree), { recursive: true });
  try {
    if (options.source) {
      run('git', [
        'clone',
        '--no-hardlinks',
        '--no-checkout',
        resolve(options.source),
        staging,
      ]);
    } else {
      run('git', [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        '--depth=1',
        '--branch',
        lock.tag,
        lock.repository,
        staging,
      ]);
    }
    git(staging, ['remote', 'set-url', 'origin', lock.repository]);
    git(staging, ['checkout', '--detach', lock.commit]);
    assert.equal(git(staging, ['rev-parse', 'HEAD']), lock.commit);
    const app = await readJson(
      join(staging, 'apps', 'kimi-code', 'package.json'),
    );
    assert.equal(
      app.version,
      lock.version,
      'Upstream version does not match the lock.',
    );
    for (const patch of lock.patches) {
      git(staging, ['apply', '--check', join(root, patch)]);
      git(staging, ['apply', join(root, patch)]);
    }
    for (const path of files) {
      assert.ok(
        !path.split('/').includes('.git') &&
          !path.split('/').includes('node_modules'),
      );
      const destination = join(staging, path);
      assert.ok(
        !existsSync(destination),
        'Overlay would overwrite an existing file; use a patch: ' + path,
      );
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(root, 'overlay', path), destination);
    }
    await writeFile(
      join(staging, '.git', 'info', 'exclude'),
      '\n/' + markerName + '\n',
      { flag: 'a' },
    );
    const marker = {
      commit: lock.commit,
      inputHash,
      sourceState: await sourceState(staging),
    };
    await writeFile(
      join(staging, markerName),
      JSON.stringify(marker, null, 2) + '\n',
    );
    await rename(staging, worktree);
    return worktree;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: { source: { type: 'string' }, worktree: { type: 'string' } },
  });
  console.log(await prepareSource(values));
}
