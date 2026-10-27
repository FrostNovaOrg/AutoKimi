import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installArchive, releaseAssets } from '../tools/bootstrap.mjs';
import { projectRoot } from '../tools/common.mjs';

async function fixture(t, platform = process.platform) {
  const root = await mkdtemp(join(tmpdir(), "autokimi bootstrap's-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'package');
  await mkdir(join(source, 'build-kit/tools'), { recursive: true });
  await writeFile(
    join(source, 'autokimi-package.json'),
    JSON.stringify({
      platform,
      arch: process.arch,
      autoKimi: { version: '0.2.2' },
    }),
  );
  await writeFile(
    join(source, 'build-kit/tools/install.mjs'),
    `import{writeFile}from'node:fs/promises';const a=process.argv.slice(2);const h=a[a.indexOf('--home')+1];await writeFile(h+'/installed',JSON.stringify(a));console.log(JSON.stringify({launcher:h+'/bin/autokimi',version:'2.3.3'}));`,
  );
  const archive = join(root, 'runtime.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await writeFile(join(root, 'SHA256SUMS'), `${digest}  runtime.tar.gz\n`);
  const home = join(root, 'home');
  await mkdir(home);
  return { root, archive, home };
}

test('installs a checksummed archive from a path with spaces and preserves arguments', async (t) => {
  const f = await fixture(t);
  const previousMask = process.umask(0o077);
  t.after(() => process.umask(previousMask));
  const receipt = await installArchive(f.archive, {
    home: f.home,
    timeout: '45000',
  });
  assert.equal(receipt.version, '2.3.3');
  const args = JSON.parse(await readFile(join(f.home, 'installed'), 'utf8'));
  assert.equal(args[args.indexOf('--home') + 1], f.home);
  assert.equal(args[args.indexOf('--timeout-ms') + 1], '45000');
  assert.equal(existsSync(args[args.indexOf('--package') + 1]), false);
});

test('rejects modified archives before running the package installer', async (t) => {
  const f = await fixture(t);
  await writeFile(f.archive, 'corrupted archive');
  await assert.rejects(
    installArchive(f.archive, { home: f.home }),
    /checksum mismatch/,
  );
  assert.equal(existsSync(join(f.home, 'installed')), false);
});

test('rejects a wrong-platform runtime before running the package installer', async (t) => {
  const f = await fixture(t, 'unsupported');
  await assert.rejects(
    installArchive(f.archive, { home: f.home }),
    /platform mismatch/,
  );
  assert.equal(existsSync(join(f.home, 'installed')), false);
});

test('rejects a package whose identity differs from the requested release', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    installArchive(f.archive, { home: f.home, version: 'v9.0.0' }),
    /release version mismatch/,
  );
  assert.equal(existsSync(join(f.home, 'installed')), false);
});

test('resolves release assets only for this platform and official download origin', async () => {
  const name = `autokimi-v0.2.2-${process.platform}-${process.arch}.tar.gz`;
  const asset = (name) => ({
    name,
    browser_download_url: `https://github.com/FrostNovaOrg/AutoKimi/releases/download/v0.2.2/${name}`,
  });
  const release = {
    tag_name: 'v0.2.2',
    assets: [asset(name), asset('SHA256SUMS')],
  };
  const fetcher = async () => ({ ok: true, json: async () => release });
  assert.equal((await releaseAssets('v0.2.2', fetcher)).name, name);
  release.assets[0].browser_download_url =
    'https://example.test/package.tar.gz';
  await assert.rejects(
    releaseAssets('v0.2.2', fetcher),
    /https:\/\/github.com/,
  );
  assert.equal(
    await releaseAssets(undefined, async () => ({ status: 404 })),
    undefined,
  );
  await assert.rejects(releaseAssets('main', fetcher), /AutoKimi tag/);
});

test('shell help needs no downloads, and invalid options fail clearly', () => {
  const help = execFileSync('sh', [join(projectRoot, 'install.sh'), '--help'], {
    encoding: 'utf8',
  });
  assert.match(help, /--package/);
  const result = spawnSync(
    process.execPath,
    [join(projectRoot, 'tools/bootstrap.mjs'), '--unknown'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option/);
});
