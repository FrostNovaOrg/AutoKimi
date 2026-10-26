import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { filesUnder, projectRoot, readJson, run, sha256 } from './common.mjs';

export async function projectIdentity(root = projectRoot) {
  if (
    !existsSync(join(root, '.git')) &&
    existsSync(join(root, '.autokimi-project.json'))
  )
    return readJson(join(root, '.autokimi-project.json'));
  const git = existsSync(join(root, '.git'));
  const files = git
    ? run(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: root, capture: true },
      )
        .split('\0')
        .filter(Boolean)
    : await filesUnder(root, '', [
        '.cache',
        '.artifacts',
        'node_modules',
        '.DS_Store',
      ]);
  const inputs = [];
  for (const path of [...new Set(files)].sort())
    inputs.push(path, sha256(await readFile(join(root, path))));
  return {
    version: (await readJson(join(root, 'package.json'))).version,
    revision: git
      ? run('git', ['rev-parse', 'HEAD'], { cwd: root, capture: true })
      : null,
    dirty: git
      ? run('git', ['status', '--porcelain'], { cwd: root, capture: true }) !==
        ''
      : null,
    sourceSha256: sha256(inputs.join('\0')),
  };
}
