import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { install, preparePackage } from '../tools/install.mjs';
import { projectRoot, readJson, readUpstreamLock } from '../tools/common.mjs';

const fixtureVersion = (await readUpstreamLock()).version;
const projectVersion = (await readJson(join(projectRoot, 'package.json')))
  .version;

async function fixture(t, onVersion = '') {
  const root = await mkdtemp(join(tmpdir(), "autokimi-test's-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'build');
  const app = join(source, 'apps', 'kimi-code');
  const sdk = join(source, 'packages', 'node-sdk');
  for (const path of [
    join(app, 'dist'),
    join(app, 'native'),
    join(app, 'dist-web'),
    join(sdk, 'dist'),
  ])
    await mkdir(path, { recursive: true });
  await writeFile(
    join(app, 'dist', 'main.mjs'),
    `// model-approval-review\nif(process.argv.includes('--version')){${onVersion}console.log(${JSON.stringify(fixtureVersion)})}else console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.KIMI_CODE_HOME,noUpdate:process.env.KIMI_CODE_NO_AUTO_UPDATE}));\n`,
  );
  await writeFile(join(app, 'dist-web', 'index.html'), '<html></html>');
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify({
      name: 'fixture-app',
      version: fixtureVersion,
      type: 'module',
      dependencies: { 'fixture-dependency': '1.0.0' },
      optionalDependencies: { 'fixture-unavailable': '1.0.0' },
    }),
  );
  await writeFile(
    join(sdk, 'package.json'),
    '{"name":"fixture-sdk","type":"module","dependencies":{}}',
  );
  await writeFile(
    join(sdk, 'dist', 'index.mjs'),
    `import{readFile,writeFile,rename}from'node:fs/promises';import{join}from'node:path';
export function createKimiHarness({homeDir}){const path=join(homeDir,'config.toml');let current;return{async getConfig(){current=JSON.parse(await readFile(path,'utf8'));return current},async setConfig(patch){function merge(a,b){for(const[k,v]of Object.entries(b))a[k]=v&&typeof v==='object'&&!Array.isArray(v)?merge(a[k]??{},v):v;return a}await writeFile(path+'.tmp',JSON.stringify(merge(current,patch)));await rename(path+'.tmp',path)},async close(){}}}\n`,
  );
  const dep = join(app, 'node_modules', 'fixture-dependency');
  const child = join(dep, 'node_modules', 'fixture-child');
  await mkdir(child, { recursive: true });
  await writeFile(
    join(dep, 'package.json'),
    '{"name":"fixture-dependency","version":"1.0.0","dependencies":{"fixture-child":"1.0.0"}}',
  );
  await writeFile(
    join(child, 'package.json'),
    '{"name":"fixture-child","version":"1.0.0"}',
  );
  await writeFile(join(child, 'index.js'), 'module.exports=42;');
  const home = join(root, 'home');
  await mkdir(join(home, 'bin'), { recursive: true });
  await writeFile(join(home, 'bin', 'kimi'), 'official command sentinel\n');
  const config = {
    defaultModel: 'fixture/model',
    providers: { fixture: { apiKey: 'fixture-placeholder' } },
    permission: {
      review: { timeoutMs: 65000, twoStage: false, policy: 'keep this policy' },
    },
    experimental: { another: true },
  };
  await writeFile(join(home, 'config.toml'), JSON.stringify(config));
  const packagePath = await preparePackage(join(root, 'package'), source, {
    verifySource: false,
  });
  return { root, source, home, package: packagePath, config };
}

test('packages the config SDK and production graph with contained relative links', async (t) => {
  const f = await fixture(t);
  const manifest = await readJson(join(f.package, 'autokimi-package.json'));
  assert.deepEqual(manifest.dependencies, [
    'fixture-child@1.0.0',
    'fixture-dependency@1.0.0',
  ]);
  assert.deepEqual(manifest.optionalMissing, ['fixture-unavailable']);
  assert.equal(manifest.upstreamCommit, 'unverified');
  assert.match(manifest.packageSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.compiledDuringInstall, false);
  assert.ok(existsSync(join(f.package, 'config-sdk', 'index.mjs')));
  async function visit(path) {
    for (const name of await readdir(path)) {
      const child = join(path, name);
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) {
        const link = await readlink(child);
        assert.equal(isAbsolute(link), false);
        assert.ok(!relative(f.package, resolve(path, link)).startsWith('..'));
        assert.equal(existsSync(child), true);
      } else if (stat.isDirectory()) await visit(child);
    }
  }
  await visit(f.package);
});

test('a self-contained install preserves official command and model config; launcher forwards cwd and arguments', async (t) => {
  const f = await fixture(t);
  await rm(f.source, { recursive: true });
  const receipt = await install(f);
  const config = await readJson(join(f.home, 'config.toml'));
  assert.equal(config.defaultModel, f.config.defaultModel);
  assert.deepEqual(config.providers, f.config.providers);
  assert.deepEqual(config.permission, f.config.permission);
  assert.deepEqual(config.experimental, {
    another: true,
    approval_review: true,
  });
  assert.equal(config.defaultPermissionMode, 'manual');
  assert.equal(
    await readFile(join(f.home, 'bin', 'kimi'), 'utf8'),
    'official command sentinel\n',
  );
  const result = JSON.parse(
    execFileSync(
      receipt.launcher,
      ['hello world', "an'apostrophe", '$literal'],
      { cwd: f.root, encoding: 'utf8' },
    ),
  );
  assert.deepEqual(result, {
    args: ['hello world', "an'apostrophe", '$literal'],
    cwd: await realpath(f.root),
    home: f.home,
    noUpdate: '1',
  });
  assert.equal((await lstat(receipt.launcher)).mode & 0o777, 0o755);
  const second = await install(f);
  assert.equal(second.distribution, receipt.distribution);
  assert.equal((await readdir(join(f.home, 'autokimi', 'releases'))).length, 1);
});

test('records the complete launcher hash in the installation receipt', async (t) => {
  const f = await fixture(t);
  const receipt = await install(f);
  const { sha256 } = await import('../tools/common.mjs');
  assert.equal(
    receipt.launcherSha256,
    sha256(await readFile(receipt.launcher)),
  );
});

test('rejects special permission bit changes before updating config', async (t) => {
  const f = await fixture(t);
  const { chmod } = await import('node:fs/promises');
  const main = join(f.package, 'dist', 'main.mjs');
  await chmod(main, ((await lstat(main)).mode & 0o777) | 0o4000);
  await assert.rejects(install(f), /Package content checksum/);
  assert.deepEqual(await readJson(join(f.home, 'config.toml')), f.config);
});

test('preserves a linked config on a successful install', async (t) => {
  const f = await fixture(t);
  const configPath = join(f.home, 'config.toml');
  const linked = join(f.root, 'shared-config.json');
  await writeFile(linked, await readFile(configPath));
  await rm(configPath);
  await symlink(linked, configPath);
  await install(f);
  assert.equal((await lstat(configPath)).isSymbolicLink(), true);
  const config = await readJson(linked);
  assert.equal(config.defaultModel, f.config.defaultModel);
  assert.deepEqual(config.providers, f.config.providers);
  assert.equal(config.experimental.approval_review, true);
  assert.equal(config.defaultPermissionMode, 'manual');
});

test('an explicit timeout changes only that review setting', async (t) => {
  const f = await fixture(t);
  await install({ ...f, 'timeout-ms': '90000' });
  const config = await readJson(join(f.home, 'config.toml'));
  assert.deepEqual(config.permission.review, {
    timeoutMs: 90000,
    twoStage: false,
    policy: 'keep this policy',
  });
});

test('refuses unmanaged launchers without changing config', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'bin', 'autokimi'), 'unmanaged\n');
  await assert.rejects(install(f), /not managed/);
  assert.deepEqual(await readJson(join(f.home, 'config.toml')), f.config);
});

for (const [path, error] of [
  ['dist/main.mjs', /Runtime checksum/],
  ['config-sdk/index.mjs', /SDK checksum/],
  ['native/added.bin', /Package content checksum/],
  ['dist-web/index.html', /Package content checksum/],
]) {
  test(
    'rejects modified ' + path + ' before updating the launcher or config',
    async (t) => {
      const f = await fixture(t);
      await writeFile(join(f.package, path), 'modified\n');
      await assert.rejects(install(f), error);
      assert.equal(existsSync(join(f.home, 'bin', 'autokimi')), false);
      assert.deepEqual(await readJson(join(f.home, 'config.toml')), f.config);
    },
  );
}

test('rejects an invalid timeout before any install changes', async (t) => {
  const f = await fixture(t);
  await assert.rejects(install({ ...f, 'timeout-ms': 'NaN' }), /timeout-ms/);
  assert.equal(existsSync(join(f.home, 'autokimi')), false);
});

test('production packaging rejects an unverified source tree', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    preparePackage(join(f.root, 'rejected-package'), f.source),
    /AutoKimi worktree/,
  );
});

test('rejects modified dependency contents before updating config', async (t) => {
  const f = await fixture(t);
  const dependency = await realpath(
    join(f.package, 'node_modules', 'fixture-dependency'),
  );
  const child = await realpath(
    join(dependency, 'node_modules', 'fixture-child'),
  );
  await writeFile(join(child, 'index.js'), 'modified\n');
  await assert.rejects(install(f), /Package content checksum/);
  assert.deepEqual(await readJson(join(f.home, 'config.toml')), f.config);
});

test('uses a new release when only dependency contents change', async (t) => {
  const f = await fixture(t);
  const first = await install(f);
  await writeFile(
    join(
      f.source,
      'apps/kimi-code/node_modules/fixture-dependency/node_modules/fixture-child/index.js',
    ),
    'module.exports=43;',
  );
  const packagePath = await preparePackage(
    join(f.root, 'package-2'),
    f.source,
    { verifySource: false },
  );
  const second = await install({ ...f, package: packagePath });
  assert.notEqual(second.distribution, first.distribution);
  const receipt = await readJson(join(f.home, 'autokimi', 'installation.json'));
  assert.equal(receipt.distribution, second.distribution);
  const entrypoint = join(second.distribution, 'dist', 'main.mjs').replaceAll(
    "'",
    "'\\''",
  );
  assert.ok((await readFile(receipt.launcher, 'utf8')).includes(entrypoint));
});

test('identical builds in different directories produce the same release', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  assert.deepEqual(
    await readJson(join(first.package, 'autokimi-package.json')),
    await readJson(join(second.package, 'autokimi-package.json')),
  );
  const a = await install(first);
  const b = await install({ ...second, home: first.home });
  assert.equal(a.distribution, b.distribution);
});

test('refuses a symlinked receipt before changing config or the official command', async (t) => {
  const f = await fixture(t);
  const official = join(f.home, 'bin', 'kimi');
  await mkdir(join(f.home, 'autokimi'), { recursive: true });
  await symlink(official, join(f.home, 'autokimi', 'installation.json'));
  await assert.rejects(install(f), /regular file/);
  assert.equal(await readFile(official, 'utf8'), 'official command sentinel\n');
  assert.deepEqual(await readJson(join(f.home, 'config.toml')), f.config);
  assert.equal(existsSync(join(f.home, 'bin', 'autokimi')), false);
});

test('atomically replaces a hardlinked receipt without modifying its other target', async (t) => {
  const f = await fixture(t);
  const official = join(f.home, 'bin', 'kimi');
  const receiptPath = join(f.home, 'autokimi', 'installation.json');
  await mkdir(join(f.home, 'autokimi'), { recursive: true });
  await link(official, receiptPath);
  const installed = await install(f);
  assert.equal(installed.officialCommandUnchanged, true);
  assert.equal(await readFile(official, 'utf8'), 'official command sentinel\n');
  assert.equal(
    (await readJson(receiptPath)).distribution,
    installed.distribution,
  );
});

test('copies a symlinked package root into a self-contained release', async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, 'package-alias');
  await symlink(f.package, alias);
  const receipt = await install({ ...f, package: alias });
  await rm(f.package, { recursive: true, force: true });
  const identity = execFileSync(receipt.launcher, ['--version'], {
    encoding: 'utf8',
  }).trim();
  assert.ok(identity.startsWith(`AutoKimi ${projectVersion} (`));
  assert.ok(identity.endsWith(`Kimi ${fixtureVersion}`));
});

test('refuses a symlinked existing release before changing config', async (t) => {
  const f = await fixture(t);
  const manifest = await readJson(join(f.package, 'autokimi-package.json'));
  const releases = join(f.home, 'autokimi', 'releases');
  await mkdir(releases, { recursive: true });
  await symlink(f.package, join(releases, manifest.release));
  await assert.rejects(install(f), /real directory/);
  assert.deepEqual(await readJson(join(f.home, 'config.toml')), f.config);
});

test('serializes concurrent installs into one consistent release', async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([install(f), install(f)]);
  assert.equal(first.distribution, second.distribution);
  const receipt = await readJson(join(f.home, 'autokimi', 'installation.json'));
  assert.equal(receipt.distribution, second.distribution);
  assert.equal((await readdir(join(f.home, 'autokimi', 'releases'))).length, 1);
  assert.equal(existsSync(join(f.home, 'autokimi', 'install.lock')), false);
});

for (const linkedConfig of [false, true]) {
  test(`rolls back config and launcher after a real post-config failure; linked=${linkedConfig}`, async (t) => {
    const f = await fixture(
      t,
      "process.getBuiltinModule('node:fs').chmodSync(process.env.KIMI_CODE_HOME+'/bin',0o500);",
    );
    const configPath = join(f.home, 'config.toml');
    const linked = join(f.root, 'shared-config.json');
    if (linkedConfig) {
      await writeFile(linked, await readFile(configPath));
      await rm(configPath);
      await symlink(linked, configPath);
    }
    try {
      await assert.rejects(install(f));
    } finally {
      const { chmod } = await import('node:fs/promises');
      await chmod(join(f.home, 'bin'), 0o700);
    }
    assert.deepEqual(
      await readJson(linkedConfig ? linked : configPath),
      f.config,
    );
    if (linkedConfig)
      assert.equal((await lstat(configPath)).isSymbolicLink(), true);
    assert.equal(existsSync(join(f.home, 'bin', 'autokimi')), false);
    assert.equal(
      await readFile(join(f.home, 'bin', 'kimi'), 'utf8'),
      'official command sentinel\n',
    );
  });
}

test('returns a committed install with a warning when lock cleanup fails', async (t) => {
  const f = await fixture(
    t,
    "process.getBuiltinModule('node:fs').rmSync(process.env.KIMI_CODE_HOME+'/autokimi/install.lock',{force:true});process.getBuiltinModule('node:fs').mkdirSync(process.env.KIMI_CODE_HOME+'/autokimi/install.lock');",
  );
  const receipt = await install(f);
  assert.match(receipt.cleanupWarning, /EISDIR|EPERM|directory/);
  assert.equal(
    JSON.parse(
      execFileSync(receipt.launcher, ['ordinary'], { encoding: 'utf8' }),
    ).args[0],
    'ordinary',
  );
  const persisted = await readJson(
    join(f.home, 'autokimi', 'installation.json'),
  );
  assert.equal(persisted.distribution, receipt.distribution);
  assert.equal(persisted.cleanupWarning, receipt.cleanupWarning);
  assert.equal(
    await readFile(join(f.home, 'bin', 'kimi'), 'utf8'),
    'official command sentinel\n',
  );
  assert.equal(
    (await readJson(join(f.home, 'config.toml'))).experimental.approval_review,
    true,
  );
});

test('does not release a caller-owned installation lock', async (t) => {
  const f = await fixture(t);
  let releases = 0;
  const installLock = async () => {
    releases++;
  };
  await install({ ...f, installLock });
  assert.equal(releases, 0);
  assert.equal(existsSync(join(f.home, 'autokimi', 'install.lock')), false);
  await installLock();
  assert.equal(releases, 1);
});

test('stores an absolute Node path when PATH contains a relative entry', async (t) => {
  const f = await fixture(t);
  const relativeBin = join(f.root, 'relative-bin');
  await mkdir(relativeBin);
  await symlink(process.execPath, join(relativeBin, 'node'));
  const previous = process.env.PATH;
  process.env.PATH = relative(process.cwd(), relativeBin);
  t.after(() => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
  const receipt = await install(f);
  assert.equal(isAbsolute(receipt.node), true);
  assert.equal(await realpath(receipt.node), await realpath(process.execPath));
});

test('packages the build kit and routes updates through fresh project source', async (t) => {
  const f = await fixture(t);
  const receipt = await install(f);
  for (const path of [
    'build-kit/tools/follow-upstream.mjs',
    'build-kit/tools/update-project.mjs',
    'build-kit/.autokimi-project.json',
    'build-kit/tools/upstream-candidate.mjs',
    'build-kit/upstream.lock.json',
    'build-kit/overlay',
    'build-kit/patches/native-review.patch',
    'build-kit/package.json',
    'build-kit/README.md',
    'build-kit/README.zh-CN.md',
    'build-kit/docs',
    'build-kit/docs/en/installation.md',
    'build-kit/docs/en/configuration.md',
    'build-kit/test',
  ])
    assert.equal(existsSync(join(receipt.distribution, path)), true, path);
  assert.equal(
    existsSync(join(receipt.distribution, 'build-kit', 'build-kit')),
    false,
  );
  const launcher = await readFile(receipt.launcher, 'utf8');
  assert.match(launcher, /if \[ "\$1" = "update" \]/);
  assert.match(launcher, /if \[ "\$1" = "upgrade" \]/);
  assert.match(launcher, /--upgrade "\$@"/);
  assert.match(
    execFileSync(receipt.launcher, ['update', '--help'], {
      encoding: 'utf8',
    }),
    /Without --install/,
  );
  assert.match(
    execFileSync(receipt.launcher, ['upgrade', '--help'], {
      encoding: 'utf8',
    }),
    /autokimi upgrade/,
  );
  assert.deepEqual(
    JSON.parse(
      execFileSync(receipt.launcher, ['ordinary'], { encoding: 'utf8' }),
    ).args,
    ['ordinary'],
  );
  assert.equal(
    await readFile(join(f.home, 'bin', 'kimi'), 'utf8'),
    'official command sentinel\n',
  );
  const kit = join(receipt.distribution, 'build-kit');
  const { pathToFileURL } = await import('node:url');
  const { followUpstream } = await import(
    pathToFileURL(join(kit, 'tools/follow-upstream.mjs'))
  );
  let checks = 0;
  const result = await followUpstream(
    { workRoot: join(f.root, 'candidate') },
    {
      createCandidate: async () => ({
        lock: await readJson(join(kit, 'upstream.lock.json')),
      }),
      runCommand: (command, args, options) => {
        assert.notEqual(
          command,
          'git',
          'A packaged build kit has no Git metadata',
        );
        if (command === 'npm' && args.join(' ') === 'run check') {
          checks++;
          execFileSync(command, args, { ...options, stdio: 'pipe' });
        }
      },
      preparePackage: async () => f.package,
    },
  );
  assert.equal(checks, 1);
  assert.equal(result.status, 'candidate');
  execFileSync('git', ['init', '-q', f.root]);
  await writeFile(join(kit, 'unexpected.pem'), 'fixture');
  assert.throws(
    () =>
      execFileSync(process.execPath, ['tools/check-repo.mjs'], {
        cwd: kit,
        stdio: 'pipe',
      }),
    /private file/,
  );
});
