import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { followUpstream } from '../tools/follow-upstream.mjs';
import { projectRoot, readJson } from '../tools/common.mjs';

async function fixture(t) {
  const workRoot = await mkdtemp(join(tmpdir(), 'autokimi-follow-test-'));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  const lock = {
    repository: 'https://example.invalid/official.git',
    tag: '@moonshot-ai/kimi-code@2.3.1',
    version: '2.3.1',
    commit: '684bae9ea6a437f3bae98bba1dcb797a917d500b',
    node: '24.15.0',
    pnpm: '10.33.0',
    patches: [],
  };
  const commands = [];
  const events = [];
  const calls = { install: 0, officialUpgrades: 0, officialVersionReads: 0 };
  const createCandidate = async () => ({
    lock,
    evidence: { commit: lock.commit },
  });
  const runCommand = (command, args) => {
    commands.push([command, ...args]);
    events.push(args[0]);
  };
  const preparePackage = async (destination) => {
    await mkdir(destination, { recursive: true });
    await writeFile(
      join(destination, 'autokimi-package.json'),
      JSON.stringify({
        release: 'candidate-release',
        version: lock.version,
        upstreamCommit: lock.commit,
        packageSha256: 'b'.repeat(64),
      }),
    );
    return destination;
  };
  const install = async (options) => {
    assert.equal(typeof options.installLock, 'function');
    calls.install++;
    events.push('autokimi-install');
    return { distribution: 'installed-release' };
  };
  const f = {
    workRoot,
    lock,
    commands,
    events,
    calls,
    currentInstallation: undefined,
    officialVersion: '2.3.0',
    afterUpgrade: undefined,
    upgradeError: undefined,
  };
  f.dependencies = {
    createCandidate,
    runCommand,
    preparePackage,
    install,
    acquireInstallLock: async () => {
      events.push('install-lock');
      return async () => {
        events.push('install-unlock');
      };
    },
    currentInstallation: async () => f.currentInstallation,
    officialVersion: async () => {
      calls.officialVersionReads++;
      return f.officialVersion;
    },
    upgradeOfficial: async () => {
      calls.officialUpgrades++;
      events.push('official-upgrade');
      if (f.upgradeError !== undefined) throw new Error(f.upgradeError);
      f.officialVersion = f.afterUpgrade ?? lock.version;
    },
  };
  return f;
}

test('builds a candidate without installing unless explicitly requested', async (t) => {
  const f = await fixture(t);
  const report = await followUpstream(
    { workRoot: f.workRoot, version: '2.3.1' },
    f.dependencies,
  );
  assert.equal(report.status, 'candidate');
  assert.equal(report.installRequested, false);
  assert.equal(f.calls.install, 0);
  assert.equal(report.release, 'candidate-release');
  assert.deepEqual(
    f.commands.map((entry) => entry[1]).filter((entry) => entry.includes('tools/')),
    [
      'tools/build.mjs',
      'tools/test-upstream.mjs',
    ],
  );
  const persisted = await readJson(report.reportPath);
  assert.equal(persisted.status, 'candidate');
  assert.equal(persisted.lock.commit, f.lock.commit);
});

test('installs only after build, tests and packaging when explicitly requested', async (t) => {
  const f = await fixture(t);
  const home = join(f.workRoot, 'home');
  const report = await followUpstream(
    { workRoot: f.workRoot, version: '2.3.1', install: true, home },
    f.dependencies,
  );
  assert.equal(report.status, 'installed');
  assert.equal(report.installRequested, true);
  assert.equal(f.calls.install, 1);
  assert.equal(report.stage, 'complete');
  assert.equal(report.receipt.distribution, 'installed-release');
  assert.equal((await readJson(report.reportPath)).status, 'installed');
});

test('stops at the first failed stage and records failure without installing', async (t) => {
  const f = await fixture(t);
  f.dependencies.runCommand = (command, args) => {
    f.commands.push([command, ...args]);
    if (args.includes('tools/test-upstream.mjs'))
      throw new Error('synthetic upstream failure');
  };
  await assert.rejects(
    followUpstream(
      { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
      f.dependencies,
    ),
    /synthetic upstream failure/,
  );
  assert.equal(f.calls.install, 0);
  assert.equal(f.calls.officialUpgrades, 0);
  assert.equal(f.calls.officialVersionReads, 0);
  const report = await readJson(join(f.workRoot, 'report.json'));
  assert.equal(report.status, 'failed');
  assert.equal(report.stage, 'test');
  assert.match(report.error, /synthetic upstream failure/);
});

test('upgrade validates before updating official and then installs AutoKimi', async (t) => {
  const f = await fixture(t);
  const home = join(f.workRoot, 'home');
  const report = await followUpstream(
    { workRoot: f.workRoot, version: '2.3.1', upgrade: true, home },
    f.dependencies,
  );
  assert.equal(report.status, 'installed');
  assert.equal(report.officialStatus, 'updated');
  assert.equal(report.officialVersionBefore, '2.3.0');
  assert.equal(report.officialVersionAfter, '2.3.1');
  assert.equal(report.autoKimiStatus, 'installed');
  assert.equal(report.partial, false);
  assert.equal(f.calls.officialUpgrades, 1);
  assert.equal(f.calls.officialVersionReads, 2);
  assert.equal(f.calls.install, 1);
  assert.ok(
    f.events.indexOf('tools/test-upstream.mjs') <
      f.events.indexOf('official-upgrade'),
  );
  assert.deepEqual(f.events.slice(-2), [
    'autokimi-install',
    'install-unlock',
  ]);
});

test('upgrade does nothing when official and AutoKimi are already current', async (t) => {
  const f = await fixture(t);
  f.officialVersion = f.lock.version;
  f.currentInstallation = {
    version: f.lock.version,
    packageSha256: 'b'.repeat(64),
  };
  const report = await followUpstream(
    { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
    f.dependencies,
  );
  assert.equal(report.status, 'unchanged');
  assert.equal(report.officialStatus, 'current');
  assert.equal(report.autoKimiStatus, 'unchanged');
  assert.equal(f.calls.officialUpgrades, 0);
  assert.equal(f.calls.install, 0);
});

test('upgrade installs an older AutoKimi without changing current official', async (t) => {
  const f = await fixture(t);
  f.officialVersion = f.lock.version;
  f.currentInstallation = { version: '2.3.0', packageSha256: 'outdated' };
  const report = await followUpstream(
    { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
    f.dependencies,
  );
  assert.equal(report.status, 'installed');
  assert.equal(report.officialStatus, 'current');
  assert.equal(report.autoKimiStatus, 'installed');
  assert.equal(f.calls.officialUpgrades, 0);
  assert.equal(f.calls.install, 1);
});

test('upgrade does not downgrade a newer AutoKimi installation', async (t) => {
  const f = await fixture(t);
  f.officialVersion = f.lock.version;
  f.currentInstallation = { version: '9.9.9', packageSha256: 'newer' };
  const report = await followUpstream(
    { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
    f.dependencies,
  );
  assert.equal(report.status, 'unchanged');
  assert.equal(report.autoKimiStatus, 'already-newer');
  assert.equal(f.calls.officialUpgrades, 0);
  assert.equal(f.calls.install, 0);
});

test('official upgrade failure stops before AutoKimi installation', async (t) => {
  const f = await fixture(t);
  f.upgradeError = 'synthetic official upgrade failure';
  await assert.rejects(
    followUpstream(
      { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
      f.dependencies,
    ),
    /synthetic official upgrade failure/,
  );
  assert.equal(f.calls.install, 0);
  const report = await readJson(join(f.workRoot, 'report.json'));
  assert.equal(report.status, 'failed');
  assert.equal(report.stage, 'official');
  assert.equal(report.officialStatus, 'failed');
  assert.equal(report.autoKimiStatus, 'not-attempted');
  assert.equal(report.partial, false);
});

test('AutoKimi installation failure is partial after official upgraded', async (t) => {
  const f = await fixture(t);
  f.dependencies.install = async () => {
    f.calls.install++;
    throw new Error('synthetic AutoKimi installation failure');
  };
  await assert.rejects(
    followUpstream(
      { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
      f.dependencies,
    ),
    /synthetic AutoKimi installation failure/,
  );
  const report = await readJson(join(f.workRoot, 'report.json'));
  assert.equal(report.status, 'partial');
  assert.equal(report.stage, 'install');
  assert.equal(report.officialStatus, 'updated');
  assert.equal(report.autoKimiStatus, 'failed');
  assert.equal(report.autoKimiInstalled, false);
  assert.equal(report.receipt, undefined);
  assert.equal(report.partial, true);
});

test('an official upgrade that leaves the old version stops installation', async (t) => {
  const f = await fixture(t);
  f.afterUpgrade = '2.3.0';
  await assert.rejects(
    followUpstream(
      { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
      f.dependencies,
    ),
    /did not reach|did not change/,
  );
  assert.equal(f.calls.install, 0);
  const report = await readJson(join(f.workRoot, 'report.json'));
  assert.equal(report.status, 'failed');
  assert.equal(report.stage, 'official');
  assert.equal(report.officialStatus, 'failed');
  assert.equal(report.officialVersionAfter, '2.3.0');
  assert.equal(report.autoKimiStatus, 'not-attempted');
});

test('official upgrade requires installation intent before doing work', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    followUpstream(
      { workRoot: f.workRoot, version: '2.3.1', official: true },
      f.dependencies,
    ),
    /requires --install/,
  );
  assert.equal(f.commands.length, 0);
  assert.equal(f.calls.officialUpgrades, 0);
  assert.equal(f.calls.officialVersionReads, 0);
  assert.equal(f.calls.install, 0);
});

test('candidate-only defaults stay in project artifacts without reading the installation', async (t) => {
  const previousAuto = process.env.AUTOKIMI_HOME;
  const previousKimi = process.env.KIMI_CODE_HOME;
  delete process.env.AUTOKIMI_HOME;
  delete process.env.KIMI_CODE_HOME;
  t.after(() => {
    for (const [name, value] of [
      ['AUTOKIMI_HOME', previousAuto],
      ['KIMI_CODE_HOME', previousKimi],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const f = await fixture(t);
  const report = await followUpstream(
    { version: '2.3.1' },
    f.dependencies,
  );
  const work = dirname(report.reportPath);
  assert.equal(
    dirname(work),
    join(projectRoot, '.artifacts', 'upstream-candidates'),
  );
  t.after(() => rm(work, { recursive: true, force: true }));
  assert.equal(report.status, 'candidate');
  assert.equal(f.calls.install, 0);
  assert.equal(f.calls.officialVersionReads, 0);
  assert.equal((await readJson(report.reportPath)).status, 'candidate');
});

test('install and upgrade honor KIMI_CODE_HOME after explicit home and AUTOKIMI_HOME', async (t) => {
  const previousAuto = process.env.AUTOKIMI_HOME;
  const previousKimi = process.env.KIMI_CODE_HOME;
  const f = await fixture(t);
  const kimiHome = join(f.workRoot, 'kimi-home');
  const autoHome = join(f.workRoot, 'auto-home');
  const expected = [kimiHome, autoHome];
  const seen = [];
  f.dependencies.currentInstallation = async (home) => {
    assert.equal(home, expected[seen.length]);
    return undefined;
  };
  f.dependencies.officialVersion = async (home) => {
    assert.equal(home, expected[seen.length]);
    return f.lock.version;
  };
  f.dependencies.install = async (options) => {
    seen.push(options.home);
    return { distribution: 'installed-release' };
  };
  delete process.env.AUTOKIMI_HOME;
  process.env.KIMI_CODE_HOME = kimiHome;
  t.after(() => {
    if (previousAuto === undefined) delete process.env.AUTOKIMI_HOME;
    else process.env.AUTOKIMI_HOME = previousAuto;
    if (previousKimi === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimi;
  });
  await followUpstream(
    { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
    f.dependencies,
  );
  process.env.AUTOKIMI_HOME = autoHome;
  await followUpstream(
    { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
    f.dependencies,
  );
  assert.deepEqual(seen, expected);
});

test('rechecks installation after the lock wait and does not downgrade it', async (t) => {
  const f = await fixture(t);
  f.currentInstallation = { version: '2.3.0', packageSha256: 'old' };
  let locked = false;
  f.dependencies.acquireInstallLock = async () => {
    f.events.push('install-wait');
    await Promise.resolve();
    f.currentInstallation = { version: '9.9.9', packageSha256: 'newer' };
    locked = true;
    f.events.push('install-lock');
    return async () => {
      locked = false;
      f.events.push('install-unlock');
    };
  };
  f.dependencies.currentInstallation = async () => {
    assert.equal(locked, true);
    f.events.push('read-installation');
    return f.currentInstallation;
  };
  f.dependencies.officialVersion = async () => {
    assert.equal(locked, true);
    return f.lock.version;
  };
  const report = await followUpstream(
    { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
    f.dependencies,
  );
  assert.equal(report.status, 'unchanged');
  assert.equal(report.autoKimiStatus, 'already-newer');
  assert.equal(f.calls.install, 0);
  assert.equal(f.calls.officialUpgrades, 0);
  assert.deepEqual(f.events.slice(-4), [
    'install-wait',
    'install-lock',
    'read-installation',
    'install-unlock',
  ]);
});

test('records a partial official upgrade when its command fails after updating', async (t) => {
  const f = await fixture(t);
  const upgrade = f.dependencies.upgradeOfficial;
  f.dependencies.upgradeOfficial = async (home) => {
    await upgrade(home);
    throw new Error('synthetic post-upgrade command failure');
  };
  await assert.rejects(
    followUpstream(
      { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
      f.dependencies,
    ),
    /post-upgrade command failure/,
  );
  assert.equal(f.calls.install, 0);
  const report = await readJson(join(f.workRoot, 'report.json'));
  assert.equal(report.status, 'partial');
  assert.equal(report.partial, true);
  assert.equal(report.officialStatus, 'updated');
  assert.equal(report.officialVersionAfter, f.lock.version);
  assert.equal(report.officialRestartRequired, true);
  assert.equal(report.autoKimiStatus, 'not-attempted');
  assert.equal(f.events.at(-1), 'install-unlock');
});

test('records unknown when the official version cannot be read after upgrade', async (t) => {
  const f = await fixture(t);
  const readVersion = f.dependencies.officialVersion;
  f.dependencies.officialVersion = async (home) => {
    if (f.calls.officialVersionReads === 0) return readVersion(home);
    throw new Error('synthetic official version read failure');
  };
  await assert.rejects(
    followUpstream(
      { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
      f.dependencies,
    ),
    /official version read failure/,
  );
  assert.equal(f.calls.install, 0);
  const report = await readJson(join(f.workRoot, 'report.json'));
  assert.equal(report.status, 'failed');
  assert.equal(report.partial, false);
  assert.equal(report.officialStatus, 'unknown');
  assert.equal(report.officialVersionAfter, undefined);
  assert.equal(report.autoKimiStatus, 'not-attempted');
  assert.equal(f.events.at(-1), 'install-unlock');
});

test('keeps a successful upgrade result when outer lock cleanup fails', async (t) => {
  const f = await fixture(t);
  f.dependencies.acquireInstallLock = async () => async () => {
    throw new Error('synthetic outer lock cleanup failure');
  };
  const report = await followUpstream(
    { workRoot: f.workRoot, version: '2.3.1', upgrade: true },
    f.dependencies,
  );
  assert.equal(report.status, 'installed');
  assert.equal(report.autoKimiInstalled, true);
  assert.match(report.cleanupWarning, /outer lock cleanup failure/);
  assert.match(report.receipt.cleanupWarning, /outer lock cleanup failure/);
  assert.equal((await readJson(report.reportPath)).status, 'installed');
});
