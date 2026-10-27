import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repository = 'FrostNovaOrg/AutoKimi';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options });

function environment() {
  const env = {
    ...process.env,
    PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ''),
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

async function get(url) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { 'User-Agent': 'AutoKimi-installer' };
  if (token && ['api.github.com', 'github.com'].includes(new URL(url).hostname))
    headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(120000),
  });
  if (response.status !== 404 && !response.ok)
    throw new Error(
      `Download failed: HTTP ${response.status} (${new URL(url).hostname})`,
    );
  return response;
}

export async function releaseAssets(version, fetcher = get) {
  if (version !== undefined)
    assert.match(
      version,
      /^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/,
      'Use an AutoKimi tag such as v0.2.2',
    );
  const response = await fetcher(
    `https://api.github.com/repos/${repository}/releases/${version ? 'tags/' + version : 'latest'}`,
  );
  if (response.status === 404) return undefined;
  assert.ok(response.ok, 'Cannot read AutoKimi release metadata');
  const release = await response.json();
  assert.match(release.tag_name, /^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  const name = `autokimi-${release.tag_name}-${process.platform}-${process.arch}.tar.gz`;
  const archive = release.assets?.find((asset) => asset.name === name);
  const checksum = release.assets?.find((asset) => asset.name === 'SHA256SUMS');
  if (!archive || !checksum) return undefined;
  for (const asset of [archive, checksum]) {
    const url = new URL(asset.browser_download_url);
    assert.equal(url.origin, 'https://github.com');
    assert.ok(
      url.pathname.startsWith(`/${repository}/releases/download/`),
      'Unexpected release download URL',
    );
  }
  return {
    name,
    archive: archive.browser_download_url,
    checksum: checksum.browser_download_url,
    version: release.tag_name,
  };
}

export async function installArchive(archive, options = {}) {
  assert.equal(typeof options.home, 'string', 'Installation home is required');
  archive = resolve(archive);
  const checksums = await readFile(
    options.checksums ?? join(dirname(archive), 'SHA256SUMS'),
    'utf8',
  );
  const rows = checksums
    .split(/\r?\n/)
    .map((line) => /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line))
    .filter(Boolean);
  const matches = rows.filter((match) => match[2] === basename(archive));
  assert.equal(
    matches.length,
    1,
    'Archive needs one matching SHA-256 entry in SHA256SUMS',
  );
  assert.equal(
    sha256(await readFile(archive)),
    matches[0][1].toLowerCase(),
    'Archive checksum mismatch',
  );
  const paths = run('tar', ['-tzf', archive], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
  assert.ok(paths.length > 0, 'Empty runtime archive');
  assert.ok(
    paths.every(
      (path) =>
        !path.startsWith('/') &&
        !path.includes('\\') &&
        !path.split('/').includes('..'),
    ),
    'Archive contains an unsafe path',
  );
  const temporary = await mkdtemp(join(tmpdir(), 'autokimi-runtime-'));
  try {
    run('tar', ['-xzpf', archive, '-C', temporary]);
    const manifest = JSON.parse(
      await readFile(join(temporary, 'autokimi-package.json'), 'utf8'),
    );
    if (options.version !== undefined)
      assert.equal(
        'v' + manifest.autoKimi?.version,
        options.version,
        'Runtime release version mismatch',
      );
    assert.equal(
      manifest.platform,
      process.platform,
      'Runtime platform mismatch',
    );
    assert.equal(manifest.arch, process.arch, 'Runtime architecture mismatch');
    const args = [
      join(temporary, 'build-kit', 'tools', 'install.mjs'),
      '--package',
      temporary,
      '--home',
      options.home,
    ];
    if (options.timeout !== undefined)
      args.push('--timeout-ms', options.timeout);
    return JSON.parse(
      run(process.execPath, args, {
        cwd: temporary,
        env: environment(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        maxBuffer: 4 * 1024 * 1024,
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function installSource(options, temporary) {
  console.log(
    'Building the pinned runtime from source; this downloads dependencies and may use several GB.',
  );
  const source = join(temporary, 'source');
  const env = { ...environment(), GIT_TERMINAL_PROMPT: '0' };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    const index = Number(env.GIT_CONFIG_COUNT || 0);
    assert.ok(
      Number.isSafeInteger(index) && index >= 0,
      'Invalid Git configuration environment',
    );
    env.GIT_CONFIG_COUNT = String(index + 1);
    env[`GIT_CONFIG_KEY_${index}`] = 'http.https://github.com/.extraheader';
    env[`GIT_CONFIG_VALUE_${index}`] =
      'Authorization: Basic ' +
      Buffer.from(`x-access-token:${token}`).toString('base64');
  }
  try {
    run('git', ['--version'], { env, stdio: 'ignore' });
  } catch {
    throw new Error(
      'Source installation needs Git. Install Git, or use a published runtime package.',
    );
  }
  run(
    'git',
    [
      'clone',
      '--depth=1',
      '--branch',
      options.version || 'main',
      `https://github.com/${repository}.git`,
      source,
    ],
    { env },
  );
  const lock = JSON.parse(
    await readFile(join(source, 'upstream.lock.json'), 'utf8'),
  );
  assert.match(lock.pnpm, /^\d+\.\d+\.\d+$/);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    run(npm, ['--version'], { env: environment(), stdio: 'ignore' });
  } catch {
    throw new Error(
      'Source installation needs npm from the Node.js distribution.',
    );
  }
  run(
    npm,
    [
      'exec',
      '--yes',
      '--package',
      `pnpm@${lock.pnpm}`,
      '--',
      process.execPath,
      join(source, 'tools', 'build.mjs'),
    ],
    { cwd: source, env: environment() },
  );
  const args = [join(source, 'tools', 'install.mjs'), '--home', options.home];
  if (options.timeout !== undefined) args.push('--timeout-ms', options.timeout);
  return JSON.parse(
    run(process.execPath, args, {
      cwd: source,
      env: environment(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
}

export async function bootstrap(values) {
  assert.ok(
    ['darwin', 'linux'].includes(process.platform) &&
      ['arm64', 'x64'].includes(process.arch),
    'Supported platforms: macOS/Linux on ARM64 or x64',
  );
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(
    major > 24 || (major === 24 && minor >= 15),
    'Node.js >=24.15.0 is required',
  );
  const home = resolve(
    values.home ||
      process.env.AUTOKIMI_HOME ||
      process.env.KIMI_CODE_HOME ||
      join(homedir(), '.kimi-code'),
  );
  const options = {
    home,
    timeout: values['timeout-ms'],
    version: values.version,
  };
  if (options.version !== undefined)
    assert.match(
      options.version,
      /^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/,
      'Use an AutoKimi tag such as v0.2.2',
    );
  if (options.timeout !== undefined)
    assert.ok(
      /^\d+$/.test(options.timeout) &&
        Number(options.timeout) >= 1000 &&
        Number(options.timeout) <= 120000,
      '--timeout-ms must be between 1000 and 120000',
    );
  assert.ok(!(values.package && values.source), 'Choose --package or --source');
  const temporary = await mkdtemp(join(tmpdir(), 'autokimi-install-'));
  let receipt;
  try {
    if (values.package) receipt = await installArchive(values.package, options);
    else {
      const release = values.source
        ? undefined
        : await releaseAssets(options.version);
      if (release) {
        console.log(`Downloading ${release.name}`);
        for (const [url, name] of [
          [release.archive, release.name],
          [release.checksum, 'SHA256SUMS'],
        ]) {
          const response = await get(url);
          assert.ok(response.ok, `Cannot download ${name}`);
          await writeFile(
            join(temporary, name),
            new Uint8Array(await response.arrayBuffer()),
          );
        }
        receipt = await installArchive(join(temporary, release.name), {
          ...options,
          version: release.version,
        });
      } else {
        if (options.version && !values.source)
          throw new Error(
            'No runtime package for the requested release and platform. Use --source to build its tag.',
          );
        console.log(
          'No published runtime for this platform; using the source installer.',
        );
        receipt = await installSource(options, temporary);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(
    `\nAutoKimi ${receipt.autoKimi?.version ?? ''} installed (Kimi ${receipt.version}).`,
  );
  console.log(`Start: ${quote(receipt.launcher)}`);
  if (
    !(process.env.PATH || '')
      .split(delimiter)
      .includes(dirname(receipt.launcher))
  )
    console.log(
      `For this terminal: export PATH=${quote(dirname(receipt.launcher))}:"$PATH"`,
    );
  return receipt;
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        home: { type: 'string' },
        package: { type: 'string' },
        source: { type: 'boolean' },
        version: { type: 'string' },
        'timeout-ms': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help)
      console.log(
        'Usage: sh install.sh [--source | --package archive.tar.gz] [--version v0.2.2] [--home directory] [--timeout-ms 90000]\nPrefers a verified runtime release; otherwise builds pinned sources. Native kimi is preserved.',
      );
    else await bootstrap(values);
  } catch (error) {
    console.error(`AutoKimi installation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
