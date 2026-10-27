import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMain, sha256 } from './common.mjs';
import { preparePackage } from './install.mjs';

export async function packageRelease(options = {}) {
  const output = resolve(options.output ?? '.artifacts/release');
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, '.package-'));
  try {
    const runtime = await preparePackage(
      join(temporary, 'runtime'),
      options.source,
    );
    const manifest = JSON.parse(
      await readFile(join(runtime, 'autokimi-package.json'), 'utf8'),
    );
    assert.equal(
      manifest.autoKimi.dirty,
      false,
      'Commit source changes before producing a release',
    );
    const name = `autokimi-v${manifest.autoKimi.version}-${manifest.platform}-${manifest.arch}.tar.gz`;
    const archive = join(output, name);
    assert.ok(!existsSync(archive), 'Release archive already exists');
    execFileSync('tar', ['-czf', archive, '-C', runtime, '.'], {
      stdio: 'inherit',
    });
    const checksums = join(output, 'SHA256SUMS');
    const existing = existsSync(checksums)
      ? await readFile(checksums, 'utf8')
      : '';
    assert.ok(
      !existing.split('\n').some((line) => line.endsWith(`  ${name}`)),
      'Checksum entry already exists',
    );
    await writeFile(
      checksums,
      existing + `${sha256(await readFile(archive))}  ${name}\n`,
    );
    return {
      archive,
      checksums,
      version: manifest.autoKimi.version,
      platform: manifest.platform,
      arch: manifest.arch,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: { source: { type: 'string' }, output: { type: 'string' } },
  });
  console.log(JSON.stringify(await packageRelease(values), null, 2));
}
