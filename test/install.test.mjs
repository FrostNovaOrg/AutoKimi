import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { install, preparePackage } from '../tools/install.mjs';
import { readJson } from '../tools/common.mjs';

async function fixture(t) {
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
    `// model-approval-review\nif(process.argv.includes('--version'))console.log('2.3.0');else console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.KIMI_CODE_HOME,noUpdate:process.env.KIMI_CODE_NO_AUTO_UPDATE}));\n`,
  );
  await writeFile(join(app, 'dist-web', 'index.html'), '<html></html>');
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify({
      name: 'fixture-app',
      version: '2.3.0',
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
    `import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';
export function createKimiHarness({homeDir}){const path=join(homeDir,'fixture-config.json');let current;return{async getConfig(){current=JSON.parse(await readFile(path,'utf8'));return current},async setConfig(patch){function merge(a,b){for(const[k,v]of Object.entries(b))a[k]=v&&typeof v==='object'&&!Array.isArray(v)?merge(a[k]??{},v):v;return a}await writeFile(path,JSON.stringify(merge(current,patch)))},async close(){}}}\n`,
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
  await writeFile(join(home, 'fixture-config.json'), JSON.stringify(config));
  const packagePath = await preparePackage(join(root, 'package'), source);
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
  const config = await readJson(join(f.home, 'fixture-config.json'));
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

test('an explicit timeout changes only that review setting', async (t) => {
  const f = await fixture(t);
  await install({ ...f, 'timeout-ms': '90000' });
  const config = await readJson(join(f.home, 'fixture-config.json'));
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
  assert.deepEqual(
    await readJson(join(f.home, 'fixture-config.json')),
    f.config,
  );
});

for (const [path, error] of [
  ['dist/main.mjs', /Runtime checksum/],
  ['config-sdk/index.mjs', /SDK checksum/],
]) {
  test(
    'rejects modified ' + path + ' before updating the launcher or config',
    async (t) => {
      const f = await fixture(t);
      await writeFile(join(f.package, path), 'modified\n');
      await assert.rejects(install(f), error);
      assert.equal(existsSync(join(f.home, 'bin', 'autokimi')), false);
      assert.deepEqual(
        await readJson(join(f.home, 'fixture-config.json')),
        f.config,
      );
    },
  );
}

test('rejects an invalid timeout before any install changes', async (t) => {
  const f = await fixture(t);
  await assert.rejects(install({ ...f, 'timeout-ms': 'NaN' }), /timeout-ms/);
  assert.equal(existsSync(join(f.home, 'autokimi')), false);
});
