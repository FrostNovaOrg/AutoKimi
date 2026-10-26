import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  isMain,
  projectRoot,
  readJson,
  readUpstreamLock,
  sha256,
} from './common.mjs';
import { verifyPreparedSource } from './prepare.mjs';

const marker = '# autokimi local launcher';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readOptional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicWrite(path, content, mode) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', mode);
    try {
      await file.writeFile(content);
      await file.chmod(mode);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function acquireInstallLock(home) {
  const directory = join(home, 'autokimi');
  const path = join(directory, 'install.lock');
  await mkdir(directory, { recursive: true });
  const deadline = Date.now() + 30000;
  let file;
  for (;;) {
    try {
      file = await open(path, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline)
        throw new Error(
          'Timed out waiting for the AutoKimi installation lock. If another installer crashed, remove the stale install.lock after checking that no installer is running.',
        );
      await delay(25);
    }
  }
  return async () => {
    try {
      await file.close();
    } finally {
      await rm(path, { force: true });
    }
  };
}

async function packageDigest(root) {
  const entries = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && path === 'autokimi-package.json') continue;
      const full = join(root, path);
      if (entry.isSymbolicLink()) {
        const target = await readlink(full);
        assert.ok(!isAbsolute(target), 'Package contains an absolute link');
        assert.ok(existsSync(full), 'Package link target is missing');
        const outside = relative(root, resolve(dirname(full), target));
        assert.ok(
          !isAbsolute(outside) &&
            outside !== '..' &&
            !outside.startsWith(`..${sep}`),
          'Package link escapes the package',
        );
        entries.push({ path, type: 'link', target });
      } else if (entry.isDirectory()) {
        await visit(full, path);
      } else {
        assert.ok(entry.isFile(), 'Package contains a non-regular file');
        const stat = await lstat(full);
        entries.push({
          path,
          type: 'file',
          mode: stat.mode & 0o7777,
          sha256: sha256(await readFile(full)),
        });
      }
    }
  }
  await visit(root);
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return sha256(JSON.stringify(entries));
}

function releaseId(manifest) {
  return sha256(
    JSON.stringify({
      version: manifest.version,
      upstreamCommit: manifest.upstreamCommit,
      packageSha256: manifest.packageSha256,
      dependencies: manifest.dependencies,
      optionalMissing: manifest.optionalMissing,
    }),
  ).slice(0, 16);
}

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
  options = {},
) {
  destination = resolve(destination);
  source = resolve(source);
  const verifiedSource = options.verifySource !== false;
  assert.ok(!existsSync(destination), 'Package destination must be new');
  if (verifiedSource)
    await verifyPreparedSource({
      root: projectRoot,
      worktree: source,
      lock: options.lock,
    });
  const lock = await readUpstreamLock(projectRoot, options.lock);
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
    const id = `${dependency.name.replaceAll('/', '+')}@${dependency.version}-${nodes.size}`;
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
    for (const name of [
      'overlay',
      'patches',
      'tools',
      'test',
      'docs',
      'upstream.lock.json',
      'package.json',
      'README.md',
      'AGENTS.md',
      'LICENSE',
      'LICENSE.upstream',
      'NOTICE',
    ])
      if (existsSync(join(projectRoot, name)))
        await cp(join(projectRoot, name), join(destination, 'build-kit', name), {
          recursive: true,
          dereference: true,
        });
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
      upstreamCommit: verifiedSource ? lock.commit : 'unverified',
      mainSha256,
      sdkSha256,
      packageSha256: await packageDigest(destination),
      dependencies,
      optionalMissing: [...optionalMissing].sort(),
      compiledDuringInstall: false,
    };
    manifest.release = releaseId(manifest);
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
  assert.match(manifest.packageSha256, /^[a-f0-9]{64}$/);
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
  assert.equal(
    await packageDigest(source),
    manifest.packageSha256,
    'Package content checksum mismatch',
  );
  assert.equal(manifest.release, releaseId(manifest), 'Release ID mismatch');
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
  const receiptPath = join(home, 'autokimi', 'installation.json');
  const ownsInstallLock = options.installLock === undefined;
  const releaseLock = options.installLock ?? (await acquireInstallLock(home));
  let temporary;
  let committedReceipt;
  try {
    const officialBefore = existsSync(official)
      ? sha256(await readFile(official))
      : null;
    if (
      existsSync(target) &&
      !(await readFile(target, 'utf8')).includes(marker)
    )
      throw new Error(
        'autokimi already exists and is not managed by this installer',
      );
    const receiptStat = await lstatIfExists(receiptPath);
    assert.ok(
      receiptStat === undefined || receiptStat.isFile(),
      'Installation receipt must be a regular file',
    );
    temporary = options.package
      ? undefined
      : await mkdtemp(join(tmpdir(), 'autokimi-install-'));
    const source = options.package
      ? await realpath(resolve(options.package))
      : await preparePackage(join(temporary, 'package'), options.source, {
          lock: options.lock,
        });
    const manifest = await readJson(join(source, 'autokimi-package.json'));
    await verifyPackage(source, manifest);
    let nodeCommand = process.execPath;
    for (const entry of (process.env.PATH ?? '').split(delimiter)) {
      if (!entry) continue;
      const candidate = join(entry, 'node');
      try {
        await access(candidate, constants.X_OK);
        if (realpathSync(candidate) === realpathSync(process.execPath)) {
          nodeCommand = resolve(candidate);
          break;
        }
      } catch {}
    }
    const distribution = join(home, 'autokimi', 'releases', manifest.release);
    const distributionStat = await lstatIfExists(distribution);
    if (distributionStat === undefined) {
      const staging = `${distribution}.${randomUUID()}.tmp`;
      await mkdir(dirname(distribution), { recursive: true });
      try {
        await cp(source, staging, { recursive: true, verbatimSymlinks: true });
        await rename(staging, distribution);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    } else {
      assert.ok(
        distributionStat.isDirectory(),
        'Installed release must be a real directory',
      );
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
    const configPath = join(home, 'config.toml');
    const configLink =
      (await lstatIfExists(configPath))?.isSymbolicLink() === true
        ? await realpath(configPath)
        : undefined;
    const configMode =
      configLink === undefined ? undefined : (await stat(configLink)).mode & 0o777;
    const [configBefore, launcherBefore, receiptBefore] = await Promise.all([
      readOptional(configPath),
      readOptional(target),
      readOptional(receiptPath),
    ]);
    let configurationStarted = false;
    let launcherChanged = false;
    let receiptChanged = false;
    let linkedHome;
    try {
      configurationStarted = true;
      if (configLink !== undefined) {
        linkedHome = await mkdtemp(join(tmpdir(), 'autokimi-config-'));
        if (configBefore !== undefined)
          await writeFile(join(linkedHome, 'config.toml'), configBefore);
      }
      const configurationHome = linkedHome ?? home;
      try {
        execFileSync(
          nodeCommand,
          [
            join(import.meta.dirname, 'configure.mjs'),
            join(distribution, 'config-sdk', 'index.mjs'),
            configurationHome,
            version,
            timeoutMs === undefined ? '' : String(timeoutMs),
          ],
          {
            stdio: 'inherit',
            env: {
              ...process.env,
              KIMI_CODE_HOME: configurationHome,
              KIMI_SHARE_DIR: join(configurationHome, 'legacy'),
              KIMI_CODE_WATCH: 'false',
              KIMI_DISABLE_TELEMETRY: '1',
            },
          },
        );
        if (configLink !== undefined)
          await atomicWrite(
            configLink,
            await readFile(join(configurationHome, 'config.toml')),
            configMode,
          );
      } finally {
        if (linkedHome !== undefined)
          await rm(linkedHome, { recursive: true, force: true });
      }
      const script = `#!/bin/sh\n${marker}\nexport KIMI_CODE_NO_AUTO_UPDATE=1\nexport KIMI_CODE_HOME=${quote(home)}\nexport AUTOKIMI_HOME=${quote(home)}\nif [ "$1" = "update" ]; then\n  shift\n  exec ${quote(nodeCommand)} ${quote(join(distribution, 'build-kit', 'tools', 'follow-upstream.mjs'))} "$@"\nfi\nif [ "$1" = "upgrade" ]; then\n  shift\n  exec ${quote(nodeCommand)} ${quote(join(distribution, 'build-kit', 'tools', 'follow-upstream.mjs'))} --upgrade "$@"\nfi\nexec ${quote(nodeCommand)} ${quote(join(distribution, 'dist', 'main.mjs'))} "$@"\n`;
      await mkdir(bin, { recursive: true });
      await atomicWrite(target, script, 0o755);
      launcherChanged = true;
      const receipt = {
        installedAt: new Date().toISOString(),
        launcher: target,
        distribution,
        node: nodeCommand,
        version,
        upstreamCommit: manifest.upstreamCommit,
        mainSha256: manifest.mainSha256,
        launcherSha256: sha256(script),
        officialCommandUnchanged: true,
        officialSha256: officialBefore,
        compiledDuringInstall: false,
      };
      await atomicWrite(
        receiptPath,
        JSON.stringify(receipt, null, 2) + '\n',
        0o600,
      );
      receiptChanged = true;
      assert.equal(
        existsSync(official) ? sha256(await readFile(official)) : null,
        officialBefore,
      );
      committedReceipt = receipt;
      return receipt;
    } catch (error) {
      const rollbackErrors = [];
      const restorations = [];
      if (receiptChanged)
        restorations.push(async () => {
          if (receiptBefore === undefined) await rm(receiptPath, { force: true });
          else await atomicWrite(receiptPath, receiptBefore, 0o600);
        });
      if (launcherChanged)
        restorations.push(async () => {
          if (launcherBefore === undefined) await rm(target, { force: true });
          else await atomicWrite(target, launcherBefore, 0o755);
        });
      if (configurationStarted)
        restorations.push(async () => {
          if (configBefore === undefined)
            await rm(configLink ?? configPath, { force: true });
          else if (configLink === undefined)
            await writeFile(configPath, configBefore);
          else await atomicWrite(configLink, configBefore, configMode);
        });
      for (const restore of restorations) {
        try {
          await restore();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0)
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Installation failed and rollback was incomplete',
        );
      throw error;
    }
  } finally {
    const cleanupErrors = [];
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (ownsInstallLock) {
      try {
        await releaseLock();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      if (committedReceipt === undefined)
        throw new AggregateError(cleanupErrors, 'Installation cleanup failed');
      const warning = cleanupErrors
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join('; ');
      committedReceipt.cleanupWarning = warning;
      try {
        await atomicWrite(
          receiptPath,
          JSON.stringify(committedReceipt, null, 2) + '\n',
          0o600,
        );
      } catch {
        committedReceipt.cleanupWarning = `${warning}; the cleanup warning could not be added to the installation receipt`;
      }
    }
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
      lock: { type: 'string' },
    },
  });
  if (values.prepare)
    console.log(
      await preparePackage(values.prepare, values.source, {
        lock: values.lock,
      }),
    );
  else console.log(JSON.stringify(await install(values), null, 2));
}
