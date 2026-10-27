import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  installArchive,
  releaseAssets,
  verifyReleaseAttestation,
} from '../tools/bootstrap.mjs';
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
  return { root, archive, home, sha256: digest };
}

test('installs a checksummed archive from a path with spaces and preserves arguments', async (t) => {
  const f = await fixture(t);
  const previousMask = process.umask(0o077);
  t.after(() => process.umask(previousMask));
  const receipt = await installArchive(f.archive, {
    home: f.home,
    sha256: f.sha256,
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
    installArchive(f.archive, { home: f.home, sha256: f.sha256 }),
    /checksum mismatch/,
  );
  assert.equal(existsSync(join(f.home, 'installed')), false);
});

test('rejects a wrong-platform runtime before running the package installer', async (t) => {
  const f = await fixture(t, 'unsupported');
  await assert.rejects(
    installArchive(f.archive, { home: f.home, sha256: f.sha256 }),
    /platform mismatch/,
  );
  assert.equal(existsSync(join(f.home, 'installed')), false);
});

test('rejects a package whose identity differs from the requested release', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    installArchive(f.archive, {
      home: f.home,
      sha256: f.sha256,
      version: 'v9.0.0',
    }),
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

test('a matching same-release checksum cannot authorize execution without independent trust', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    installArchive(f.archive, { home: f.home }),
    /trusted source revision/,
  );
  assert.equal(existsSync(join(f.home, 'installed')), false);
});
test('attestation verification binds repository, workflow and both source digests', () => {
  const calls = [];
  const revision = 'a'.repeat(40);
  verifyReleaseAttestation('/temporary/artifact.tar.gz', revision, (...args) =>
    calls.push(args),
  );
  assert.equal(calls[0][0], 'gh');
  const args = calls[0][1];
  assert.equal(args[args.indexOf('--source-digest') + 1], revision);
  assert.equal(args[args.indexOf('--signer-digest') + 1], revision);
  assert.ok(args.includes('--deny-self-hosted-runners'));
  assert.throws(
    () =>
      verifyReleaseAttestation('archive', revision, () => {
        throw new Error('bad signature');
      }),
    /bad signature/,
  );
});

test('an attacker replacing both the archive and its checksum still fails the trusted digest', async (t) => {
  const f = await fixture(t);
  await writeFile(f.archive, 'replacement');
  const replacementHash = createHash('sha256')
    .update('replacement')
    .digest('hex');
  await writeFile(
    join(f.root, 'SHA256SUMS'),
    replacementHash + '  runtime.tar.gz\n',
  );
  await assert.rejects(
    installArchive(f.archive, { home: f.home, sha256: f.sha256 }),
    /Trusted archive digest mismatch/,
  );
  assert.equal(existsSync(join(f.home, 'installed')), false);
});
test('the piped installer refuses a replaced bootstrap before execution', async (t) => {
  const f = await fixture(t);
  const bin = join(f.root, 'fake-bin');
  await mkdir(bin);
  const marker = join(f.root, 'bootstrap-ran');
  const payload = join(f.root, 'replaced.mjs');
  await writeFile(
    payload,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unexpected');`,
  );
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    join(bin, 'curl'),
    '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp ' +
      quote(payload) +
      ' "$2"\n',
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const result = spawnSync(
    'sh',
    [
      '-s',
      '--',
      '--revision',
      'a'.repeat(40),
      '--package',
      f.archive,
      '--sha256',
      f.sha256,
      '--home',
      f.home,
    ],
    {
      input: await readFile(join(projectRoot, 'install.sh')),
      env,
      cwd: f.root,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bootstrap checksum mismatch/);
  assert.equal(existsSync(marker), false);
});

test('the pinned piped installer accepts its matching bootstrap and a trusted local package', async (t) => {
  const f = await fixture(t);
  const bin = join(f.root, 'fake-bin');
  await mkdir(bin);
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    join(bin, 'curl'),
    '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp ' +
      quote(join(projectRoot, 'tools/bootstrap.mjs')) +
      ' "$2"\n',
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const result = spawnSync(
    'sh',
    [
      '-s',
      '--',
      '--revision',
      'a'.repeat(40),
      '--package',
      f.archive,
      '--sha256',
      f.sha256,
      '--home',
      f.home,
    ],
    {
      input: await readFile(join(projectRoot, 'install.sh')),
      env,
      cwd: f.root,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.home, 'installed')), true);
});
