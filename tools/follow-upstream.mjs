import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createUpstreamCandidate } from './upstream-candidate.mjs';
import {
  acquireInstallLock,
  install,
  preparePackage,
} from './install.mjs';
import {
  isMain,
  projectRoot,
  readJson,
  run,
} from './common.mjs';

async function writeReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
}

function versionParts(version) {
  const [main, ...suffix] = version.split('-');
  const numbers = main.split('.').map(Number);
  if (
    numbers.length !== 3 ||
    numbers.some((value) => !Number.isInteger(value) || value < 0)
  )
    throw new Error(`Invalid version: ${version}`);
  return { numbers, suffix: suffix.join('-') || undefined };
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index])
      return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }
  if (a.suffix === b.suffix) return 0;
  if (a.suffix === undefined) return 1;
  if (b.suffix === undefined) return -1;
  return a.suffix.localeCompare(b.suffix, undefined, { numeric: true });
}

async function currentInstallation(home) {
  try {
    const receipt = await readJson(
      join(home, 'autokimi', 'installation.json'),
    );
    const manifest = await readJson(
      join(receipt.distribution, 'autokimi-package.json'),
    );
    return { version: receipt.version, packageSha256: manifest.packageSha256 };
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

function officialCommand(home) {
  const command = join(home, 'bin', 'kimi');
  if (!existsSync(command))
    throw new Error(`Official Kimi command not found: ${command}`);
  return command;
}

async function officialVersion(home) {
  return run(officialCommand(home), ['--version'], {
    capture: true,
    env: {
      ...process.env,
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_DISABLE_TELEMETRY: '1',
    },
  });
}

async function upgradeOfficial(home) {
  return run(officialCommand(home), ['upgrade', '--yes'], {
    env: { ...process.env, KIMI_DISABLE_TELEMETRY: '1' },
  });
}

export async function followUpstream(options = {}, dependencies = {}) {
  const upgradeRequested = options.upgrade === true;
  options = {
    ...options,
    install: upgradeRequested || options.install === true,
    official: upgradeRequested || options.official === true,
  };
  if (options.official === true && options.install !== true)
    throw new Error('Official upgrade requires --install');
  const createCandidate = dependencies.createCandidate ?? createUpstreamCandidate;
  const runCommand = dependencies.runCommand ?? run;
  const packageRuntime = dependencies.preparePackage ?? preparePackage;
  const installCandidate = dependencies.install ?? install;
  const readInstallation = dependencies.currentInstallation ?? currentInstallation;
  const readOfficialVersion = dependencies.officialVersion ?? officialVersion;
  const upgrade = dependencies.upgradeOfficial ?? upgradeOfficial;
  const home =
    options.home ??
    process.env.AUTOKIMI_HOME ??
    process.env.KIMI_CODE_HOME ??
    (options.install || options.official
      ? join(homedir(), '.kimi-code')
      : undefined);
  const work = resolve(
    options.workRoot ??
      join(
        home
          ? join(home, 'autokimi', 'update-work')
          : join(projectRoot, '.artifacts', 'upstream-candidates'),
        randomUUID(),
      ),
  );
  const lockPath = join(work, 'candidate.lock.json');
  const reportPath = join(work, 'report.json');
  const acquireLock = dependencies.acquireInstallLock ?? acquireInstallLock;
  let installLock;
  const report = {
    status: 'running',
    stage: 'evidence',
    startedAt: new Date().toISOString(),
    installRequested: options.install === true,
    officialRequested: options.official === true,
    autoKimiInstalled: false,
    autoKimiStatus: 'pending',
    officialStatus: options.official === true ? 'pending' : 'not-requested',
    partial: false,
    reportPath,
  };
  try {
    await mkdir(work, { recursive: true });
    const { lock, evidence } = await createCandidate({
      root: projectRoot,
      version: options.version,
      cdnBase: options.cdnBase,
      auditDirectory: join(work, 'attestation'),
      lockPath,
    });
    Object.assign(report, { lock, evidence });
    report.stage = 'build';
    const worktree = join(work, 'source');
    const storeDir = resolve(options.storeDir ?? join(work, 'pnpm-store'));
    runCommand(
      process.execPath,
      [
        'tools/build.mjs',
        '--worktree',
        worktree,
        '--lock',
        lockPath,
        '--store-dir',
        storeDir,
      ],
      { cwd: projectRoot },
    );
    report.stage = 'test';
    runCommand(
      process.execPath,
      ['tools/test-upstream.mjs', '--worktree', worktree, '--lock', lockPath],
      { cwd: projectRoot },
    );
    runCommand('npm', ['test'], { cwd: projectRoot });
    runCommand('npm', ['run', 'check'], { cwd: projectRoot });
    if (existsSync(join(projectRoot, '.git')))
      runCommand('git', ['diff', '--check'], { cwd: projectRoot });
    runCommand(
      'npm',
      [
        'run',
        'test:install',
        '--',
        '--lock',
        lockPath,
        '--source',
        worktree,
      ],
      { cwd: projectRoot },
    );
    report.stage = 'package';
    const packagePath = await packageRuntime(join(work, 'runtime'), worktree, {
      lock,
    });
    const manifest = await readJson(join(packagePath, 'autokimi-package.json'));
    Object.assign(report, {
      status: 'candidate',
      stage: 'package',
      packagePath,
      release: manifest.release,
      upstreamCommit: manifest.upstreamCommit,
      packageSha256: manifest.packageSha256,
    });
    if (options.install || options.official)
      installLock = await acquireLock(home);
    const current =
      options.install || options.official
        ? await readInstallation(home)
        : undefined;
    if (options.official === true) {
      report.stage = 'official';
      const before = await readOfficialVersion(home);
      report.officialVersionBefore = before;
      report.officialTargetVersion = lock.version;
      const comparison = compareVersions(before, lock.version);
      if (comparison < 0) {
        let upgradeError;
        try {
          await upgrade(home);
        } catch (error) {
          upgradeError = error;
        }
        let after;
        try {
          after = await readOfficialVersion(home);
        } catch (error) {
          report.officialStatus = 'unknown';
          throw upgradeError ?? error;
        }
        report.officialVersionAfter = after;
        const change = compareVersions(after, before);
        if (change < 0)
          throw new Error(
            `Official Kimi upgrade changed the installed version from ${before} to ${after}.`,
          );
        if (change > 0) {
          report.officialStatus = 'updated';
          report.officialRestartRequired = true;
        }
        if (upgradeError !== undefined) throw upgradeError;
        if (change === 0)
          throw new Error(
            `Official Kimi upgrade did not change the installed version (${before}).`,
          );
        if (compareVersions(after, lock.version) < 0)
          throw new Error(
            `Official Kimi upgrade did not reach ${lock.version}; reported ${after}.`,
          );
      } else {
        report.officialStatus = comparison > 0 ? 'already-newer' : 'current';
      }
    }
    const currentVersion = current?.version;
    const currentIsNewer =
      currentVersion !== undefined &&
      compareVersions(currentVersion, manifest.version) > 0;
    const samePackage = current?.packageSha256 === manifest.packageSha256;
    if (currentIsNewer) {
      report.autoKimiStatus = 'already-newer';
    } else if (samePackage && report.officialStatus !== 'updated') {
      report.autoKimiStatus = 'unchanged';
    } else if (options.install || report.officialStatus === 'updated') {
      report.stage = 'install';
      report.receipt = await installCandidate({
        package: packagePath,
        home,
        lock,
        installLock,
      });
      report.autoKimiInstalled = true;
      report.autoKimiStatus = 'installed';
    } else {
      report.autoKimiStatus = 'unchanged';
    }
    report.stage = 'complete';
    report.status =
      report.autoKimiInstalled || report.officialStatus === 'updated'
        ? 'installed'
        : options.install || options.official
          ? 'unchanged'
          : 'candidate';
    await writeReport(reportPath, report);
    return report;
  } catch (error) {
    if (
      report.stage === 'official' &&
      report.officialStatus !== 'updated' &&
      report.officialStatus !== 'unknown'
    )
      report.officialStatus = 'failed';
    if (!report.autoKimiInstalled && report.autoKimiStatus === 'pending')
      report.autoKimiStatus =
        report.stage === 'install' ? 'failed' : 'not-attempted';
    report.partial =
      report.autoKimiInstalled || report.officialStatus === 'updated';
    Object.assign(report, {
      status: report.partial ? 'partial' : 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    await writeReport(reportPath, report);
    throw error;
  } finally {
    if (installLock !== undefined) {
      try {
        await installLock();
      } catch (error) {
        const warning = `Installation lock cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
        report.cleanupWarning = warning;
        if (report.receipt !== undefined)
          report.receipt.cleanupWarning = warning;
        try {
          await writeReport(reportPath, report);
        } catch {
          report.cleanupWarning = `${warning}; the cleanup warning could not be added to the report`;
        }
      }
    }
  }
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      install: { type: 'boolean' },
      upgrade: { type: 'boolean' },
      home: { type: 'string' },
      'work-root': { type: 'string' },
      'store-dir': { type: 'string' },
      'cdn-base': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: autokimi update [--version <semver>] [--install] [--home <path>] [--work-root <path>] [--store-dir <path>] [--cdn-base <url>]\n       autokimi upgrade [--version <semver>]\n\nWithout --install, only build and validate a candidate; the current installation is unchanged.\nupgrade validates AutoKimi first, then upgrades official Kimi when needed and installs AutoKimi.',
    );
  } else {
    const report = await followUpstream({
      version: values.version,
      install: values.upgrade === true ? true : values.install === true,
      official: values.upgrade === true,
      home: values.home,
      workRoot: values['work-root'],
      storeDir: values['store-dir'],
      cdnBase: values['cdn-base'],
    });
    console.log(JSON.stringify(report, null, 2));
  }
}
