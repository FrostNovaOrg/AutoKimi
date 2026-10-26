import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(import.meta.dirname, '..');
export const sha256 = (value) =>
  createHash('sha256').update(value).digest('hex');
export const readJson = async (path) =>
  JSON.parse(await readFile(path, 'utf8'));
export const isMain = (url) => {
  if (process.argv[1] === undefined) return false;
  const file = fileURLToPath(url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(file);
  } catch {
    return resolve(process.argv[1]) === resolve(file);
  }
};

export function run(command, args, options = {}) {
  const { capture, ...executionOptions } = options;
  return execFileSync(command, args, {
    maxBuffer: 16 * 1024 * 1024,
    ...executionOptions,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })?.trim();
}

export async function filesUnder(root, prefix = '', ignored = []) {
  const files = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (ignored.includes(path)) continue;
    if (entry.isSymbolicLink())
      throw new Error('Source symlinks are not supported: ' + path);
    if (entry.isDirectory())
      files.push(...(await filesUnder(root, path, ignored)));
    else if (entry.isFile()) files.push(path);
    else throw new Error('Unsupported source entry: ' + path);
  }
  return files.sort();
}

export function pnpmEnvironment() {
  const override = process.env.AUTOKIMI_PNPM || 'pnpm';
  const command = override.includes('/') || override.includes('\\')
    ? resolve(override)
    : override;
  return {
    command,
    env: {
      ...process.env,
      PATH: isAbsolute(command)
        ? dirname(command) + delimiter + (process.env.PATH ?? '')
        : process.env.PATH,
    },
  };
}

export function validateUpstreamLock(lock) {
  assert.ok(
    typeof lock === 'object' && lock !== null && !Array.isArray(lock),
    'Invalid upstream lock',
  );
  assert.equal(typeof lock.repository, 'string', 'Missing upstream repository');
  assert.match(lock.repository, /^https:\/\//, 'Invalid upstream repository');
  assert.equal(typeof lock.version, 'string', 'Missing upstream version');
  assert.match(lock.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const tag = lock.tag ?? '@moonshot-ai/kimi-code@' + lock.version;
  assert.equal(tag, '@moonshot-ai/kimi-code@' + lock.version);
  assert.match(lock.commit, /^[a-f0-9]{40}$/, 'Invalid upstream commit');
  if (lock.node !== undefined) {
    assert.equal(typeof lock.node, 'string', 'Invalid Node version');
    assert.ok(lock.node.length > 0, 'Invalid Node version');
  }
  if (lock.pnpm !== undefined) {
    assert.equal(typeof lock.pnpm, 'string', 'Invalid pnpm version');
    assert.ok(lock.pnpm.length > 0, 'Invalid pnpm version');
  }
  assert.ok(Array.isArray(lock.patches), 'Invalid upstream patch list');
  for (const patch of lock.patches) {
    assert.equal(typeof patch, 'string', 'Invalid upstream patch path');
    assert.ok(
      patch.startsWith('patches/') &&
        !patch.split('/').includes('..') &&
        !isAbsolute(patch),
      'Invalid upstream patch path: ' + patch,
    );
  }
  return { ...lock, tag };
}

export async function readUpstreamLock(root = projectRoot, candidate) {
  if (candidate === undefined)
    return validateUpstreamLock(
      await readJson(join(root, 'upstream.lock.json')),
    );
  if (typeof candidate === 'string')
    return validateUpstreamLock(await readJson(resolve(candidate)));
  return validateUpstreamLock(candidate);
}
