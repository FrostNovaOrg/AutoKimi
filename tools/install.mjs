import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { isMain, projectRoot, readJson, sha256 } from './common.mjs';

const marker = '# autokimi local launcher';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function packageRoot(name, from) {
  const require = createRequire(join(from, 'package.json'));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    let path = dirname(require.resolve(name));
    while (dirname(path) !== path) {
      const candidate = join(path, 'package.json');
      if (
        existsSync(candidate) &&
        JSON.parse(readFileSync(candidate, 'utf8')).name === name
      )
        return path;
      path = dirname(path);
    }
    throw new Error(`Cannot locate installed dependency ${name}`);
  }
}

export async function preparePackage(
  destination,
  source = join(projectRoot, '.cache', 'kimi-code'),
) {
  destination = resolve(destination);
  source = resolve(source);
  assert.ok(!existsSync(destination), 'Package destination must be new');
  const lock = await readJson(join(projectRoot, 'upstream.lock.json'));
  const appRoot = join(source, 'apps', 'kimi-code');
  const sdkRoot = join(source, 'packages', 'node-sdk');
  const main = await readFile(join(appRoot, 'dist', 'main.mjs'));
  const sdk = await readFile(join(sdkRoot, 'dist', 'index.mjs'));
  assert.ok(
    main.includes(Buffer.from('model-approval-review')),
    'Build with auto-review is missing',
  );
  assert.ok(
    existsSync(join(appRoot, 'dist-web', 'index.html')),
    'Built web assets are missing',
  );
  const pkg = await readJson(join(appRoot, 'package.json'));
  assert.equal(
    pkg.version,
    lock.version,
    'Build version does not match the upstream lock',
  );
  const nodes = new Map();
  const optionalMissing = new Set();
  function collect(name, from, optional = false) {
    let path;
    try {
      path = realpathSync(packageRoot(name, from));
    } catch (error) {
      if (!optional) throw error;
      optionalMissing.add(name);
      return undefined;
    }
    if (nodes.has(path)) return nodes.get(path);
    const dependency = JSON.parse(
      readFileSync(join(path, 'package.json'), 'utf8'),
    );
    const id = `${dependency.name.replaceAll('/', '+')}@${dependency.version}-${sha256(path).slice(0, 10)}`;
    const node = {
      source: path,
      name: dependency.name,
      version: dependency.version,
      target: join(destination, 'node_modules', '.store', id, 'package'),
      dependencies: [],
    };
    nodes.set(path, node);
    const optionalNames = new Set(
      Object.keys(dependency.optionalDependencies ?? {}),
    );
    for (const childName of Object.keys({
      ...dependency.dependencies,
      ...dependency.optionalDependencies,
    })) {
      const child = collect(childName, path, optionalNames.has(childName));
      if (child) node.dependencies.push({ name: childName, node: child });
    }
    return node;
  }
  const rootGroups = [];
  for (const [from, target] of [
    [appRoot, destination],
    [sdkRoot, join(destination, 'config-sdk')],
  ]) {
    const metadata = await readJson(join(from, 'package.json'));
    const roots = [];
    for (const name of Object.keys({
      ...metadata.dependencies,
      ...metadata.optionalDependencies,
    })) {
      const node = collect(
        name,
        from,
        Object.hasOwn(metadata.optionalDependencies ?? {}, name),
      );
      if (node) roots.push({ name, node });
    }
    rootGroups.push({ target, roots });
  }
  try {
    await mkdir(destination, { recursive: true });
    for (const name of ['dist', 'native', 'dist-web', 'package.json'])
      await cp(join(appRoot, name), join(destination, name), {
        recursive: true,
        dereference: true,
      });
    await cp(join(sdkRoot, 'dist'), join(destination, 'config-sdk'), {
      recursive: true,
      dereference: true,
    });
    for (const name of ['LICENSE', 'LICENSE.upstream', 'NOTICE'])
      if (existsSync(join(projectRoot, name)))
        await cp(join(projectRoot, name), join(destination, name));
    for (const node of nodes.values())
      await cp(node.source, node.target, {
        recursive: true,
        dereference: true,
        filter: (path) =>
          !relative(node.source, path).split(sep).includes('node_modules'),
      });
    async function linkDependency(parent, name, node) {
      const link = join(parent, 'node_modules', name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), node.target), link);
    }
    for (const node of nodes.values())
      for (const child of node.dependencies)
        await linkDependency(node.target, child.name, child.node);
    for (const group of rootGroups)
      for (const root of group.roots)
        await linkDependency(group.target, root.name, root.node);
    const dependencies = [...nodes.values()]
      .map((node) => `${node.name}@${node.version}`)
      .sort();
    const mainSha256 = sha256(main);
    const sdkSha256 = sha256(sdk);
    const manifest = {
      version: pkg.version,
      upstreamCommit: lock.commit,
      mainSha256,
      sdkSha256,
      release: sha256(
        JSON.stringify({
          mainSha256,
          sdkSha256,
          upstream: lock.commit,
          dependencies,
        }),
      ).slice(0, 16),
      dependencies,
      optionalMissing: [...optionalMissing].sort(),
      compiledDuringInstall: false,
    };
    await writeFile(
      join(destination, 'autokimi-package.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    return destination;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function verifyPackage(source, manifest) {
  assert.match(manifest.release, /^[a-f0-9]{16}$/, 'Invalid release ID');
  assert.equal(
    sha256(await readFile(join(source, 'dist', 'main.mjs'))),
    manifest.mainSha256,
    'Runtime checksum mismatch',
  );
  assert.equal(
    sha256(await readFile(join(source, 'config-sdk', 'index.mjs'))),
    manifest.sdkSha256,
    'Config SDK checksum mismatch',
  );
}

export async function install(options = {}) {
  if (process.platform === 'win32')
    throw new Error('This shell installer supports macOS and Linux.');
  const timeoutMs =
    options['timeout-ms'] === undefined
      ? undefined
      : Number(options['timeout-ms']);
  assert.ok(
    timeoutMs === undefined ||
      (Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120000),
    '--timeout-ms must be an integer between 1000 and 120000',
  );
  const home = resolve(
    options.home ?? process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code'),
  );
  const bin = join(home, 'bin');
  const target = join(bin, 'autokimi');
  const official = join(bin, 'kimi');
  const officialBefore = existsSync(official)
    ? sha256(await readFile(official))
    : null;
  if (existsSync(target) && !(await readFile(target, 'utf8')).includes(marker))
    throw new Error(
      'autokimi already exists and is not managed by this installer',
    );
  const temporary = options.package
    ? undefined
    : await mkdtemp(join(tmpdir(), 'autokimi-install-'));
  try {
    const source = options.package
      ? resolve(options.package)
      : await preparePackage(join(temporary, 'package'), options.source);
    const manifest = await readJson(join(source, 'autokimi-package.json'));
    await verifyPackage(source, manifest);
    let nodeCommand = process.execPath;
    for (const entry of (process.env.PATH ?? '').split(delimiter)) {
      if (!entry) continue;
      const candidate = join(entry, 'node');
      try {
        await access(candidate, constants.X_OK);
        if (realpathSync(candidate) === realpathSync(process.execPath)) {
          nodeCommand = candidate;
          break;
        }
      } catch {}
    }
    const distribution = join(home, 'autokimi', 'releases', manifest.release);
    if (!existsSync(distribution)) {
      const staging = `${distribution}.${randomUUID()}.tmp`;
      await mkdir(dirname(distribution), { recursive: true });
      try {
        await cp(source, staging, { recursive: true, verbatimSymlinks: true });
        await rename(staging, distribution);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    await verifyPackage(distribution, manifest);
    const version = execFileSync(
      nodeCommand,
      [join(distribution, 'dist', 'main.mjs'), '--version'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          KIMI_CODE_HOME: home,
          KIMI_SHARE_DIR: join(home, 'legacy'),
          KIMI_CODE_NO_AUTO_UPDATE: '1',
          KIMI_DISABLE_TELEMETRY: '1',
        },
      },
    ).trim();
    assert.equal(
      version,
      manifest.version,
      'Installed runtime version mismatch',
    );
    execFileSync(
      nodeCommand,
      [
        join(import.meta.dirname, 'configure.mjs'),
        join(distribution, 'config-sdk', 'index.mjs'),
        home,
        version,
        timeoutMs === undefined ? '' : String(timeoutMs),
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          KIMI_CODE_HOME: home,
          KIMI_SHARE_DIR: join(home, 'legacy'),
          KIMI_CODE_WATCH: 'false',
          KIMI_DISABLE_TELEMETRY: '1',
        },
      },
    );
    const script = `#!/bin/sh\n${marker}\nexport KIMI_CODE_NO_AUTO_UPDATE=1\nexport KIMI_CODE_HOME=${quote(home)}\nexec ${quote(nodeCommand)} ${quote(join(distribution, 'dist', 'main.mjs'))} "$@"\n`;
    await mkdir(bin, { recursive: true });
    const launcher = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(launcher, script, { mode: 0o755, flag: 'wx' });
      await chmod(launcher, 0o755);
      await rename(launcher, target);
    } finally {
      await rm(launcher, { force: true });
    }
    assert.equal(
      existsSync(official) ? sha256(await readFile(official)) : null,
      officialBefore,
    );
    const receipt = {
      installedAt: new Date().toISOString(),
      launcher: target,
      distribution,
      node: nodeCommand,
      version,
      upstreamCommit: manifest.upstreamCommit,
      mainSha256: manifest.mainSha256,
      officialCommandUnchanged: true,
      officialSha256: officialBefore,
      compiledDuringInstall: false,
    };
    await writeFile(
      join(home, 'autokimi', 'installation.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      { mode: 0o600 },
    );
    return receipt;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      prepare: { type: 'string' },
      package: { type: 'string' },
      source: { type: 'string' },
      home: { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
  });
  if (values.prepare)
    console.log(await preparePackage(values.prepare, values.source));
  else console.log(JSON.stringify(await install(values), null, 2));
}
