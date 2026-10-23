import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(import.meta.dirname, '..');
export const sha256 = (value) =>
  createHash('sha256').update(value).digest('hex');
export const readJson = async (path) =>
  JSON.parse(await readFile(path, 'utf8'));
export const isMain = (url) =>
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(url);

export function run(command, args, options = {}) {
  const { capture, ...executionOptions } = options;
  return execFileSync(command, args, {
    ...executionOptions,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })?.trim();
}

export async function filesUnder(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink())
      throw new Error('Source symlinks are not supported: ' + path);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

export function pnpmEnvironment() {
  const command = process.env.AUTOKIMI_PNPM || 'pnpm';
  return {
    command,
    env: {
      ...process.env,
      PATH: isAbsolute(command)
        ? dirname(command) + ':' + process.env.PATH
        : process.env.PATH,
    },
  };
}
