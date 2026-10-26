import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { projectRoot, readUpstreamLock, sha256 } from './common.mjs';
import { install, preparePackage } from './install.mjs';

const { values } = parseArgs({
  options: { lock: { type: 'string' }, source: { type: 'string' } },
});
const lock = await readUpstreamLock(projectRoot, values.lock);

process.env.KIMI_CODE_WATCH = 'false';
process.env.KIMI_DISABLE_TELEMETRY = '1';

const artifacts = join(projectRoot, '.artifacts');
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(artifacts, 'install-smoke-'));
try {
  const home = join(root, 'home');
  await mkdir(join(home, 'bin'), { recursive: true });
  const official = 'official command sentinel\n';
  await writeFile(join(home, 'bin', 'kimi'), official);
  await writeFile(
    join(home, 'config.toml'),
    `default_model = "fixture/model"
[providers.fixture]
type = "openai"
api_key = "fixture-placeholder"
base_url = "https://example.invalid/v1"
[models."fixture/model"]
provider = "fixture"
model = "fixture-model"
max_context_size = 32768
[permission.review]
timeout_ms = 65000
max_context_chars = 24000
two_stage = true
policy = "preserve this fixture policy"
`,
  );
  const packagePath = await preparePackage(
    join(root, 'runtime'),
    values.source,
    {
      lock,
    },
  );
  const first = await install({
    package: packagePath,
    home,
    lock,
    'timeout-ms': '90000',
  });
  const identity = execFileSync(first.launcher, ['--version'], {
    encoding: 'utf8',
  });
  assert.match(identity, /AutoKimi 0\.2\.0/);
  assert.ok(identity.includes('Kimi ' + lock.version));
  for (const args of [
    ['-p', 'task'],
    ['--prompt=task'],
    ['--continue', '-p', 'task'],
    ['acp'],
    ['web'],
    [],
  ]) {
    try {
      execFileSync(first.launcher, args, { encoding: 'utf8', stdio: 'pipe' });
      assert.fail('Headless entry must fail');
    } catch (error) {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /Use native kimi/);
    }
  }
  assert.match(
    execFileSync(first.launcher, ['update', '--help'], {
      encoding: 'utf8',
    }),
    /Without --install/,
  );
  assert.match(
    execFileSync(first.launcher, ['upgrade', '--help'], {
      encoding: 'utf8',
    }),
    /autokimi upgrade/,
  );
  assert.match(
    execFileSync(first.launcher, ['upgrade', '--help'], {
      encoding: 'utf8',
    }),
    /validates AutoKimi first/,
  );
  const { createKimiHarness } = await import(
    pathToFileURL(join(first.distribution, 'config-sdk', 'index.mjs')).href
  );
  const harness = createKimiHarness({
    homeDir: home,
    identity: {
      productName: 'kimi-code-cli',
      version: first.version,
      platform: 'kimi_code_cli',
    },
  });
  try {
    const config = await harness.getConfig();
    assert.equal(config.defaultModel, 'fixture/model');
    assert.equal(config.providers.fixture.apiKey, 'fixture-placeholder');
    assert.equal(
      config.providers.fixture.baseUrl,
      'https://example.invalid/v1',
    );
    assert.equal(config.models['fixture/model'].model, 'fixture-model');
    assert.equal(config.permission.review.timeoutMs, 90000);
    assert.equal(
      config.permission.review.policy,
      'preserve this fixture policy',
    );
    assert.equal(config.permission.review.twoStage, true);
    assert.equal(config.experimental.approval_review, true);
    assert.equal(config.defaultPermissionMode, 'manual');
  } finally {
    await harness.close();
  }
  const second = await install({ package: packagePath, home, lock });
  assert.equal(second.distribution, first.distribution);
  assert.equal(
    sha256(await readFile(join(home, 'bin', 'kimi'))),
    sha256(official),
  );
  console.log(
    'Real runtime install smoke passed: SDK config preserved, review enabled, launcher starts, official command preserved, reinstall stable.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
