import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkRepo } from './check-repo.mjs';
import { isMain, readJson, run } from './common.mjs';
import { projectIdentity } from './project-identity.mjs';

const REPOSITORY = 'https://github.com/FrostNovaOrg/AutoKimi.git';

export async function checkoutProject(destination, revision) {
  if (revision !== undefined)
    assert.match(revision, /^[a-f0-9]{40}$/, 'Use a full AutoKimi commit SHA');
  run('git', [
    'clone',
    '--depth=1',
    '--branch',
    'main',
    '--single-branch',
    REPOSITORY,
    destination,
  ]);
  if (revision !== undefined) {
    run('git', ['-C', destination, 'fetch', '--depth=1', 'origin', revision]);
    run('git', ['-C', destination, 'checkout', '--detach', 'FETCH_HEAD']);
    assert.equal(
      run('git', ['-C', destination, 'rev-parse', 'HEAD'], { capture: true }),
      revision,
    );
  }
}

export async function updateProject(options = {}, dependencies = {}) {
  const home = resolve(
    options.home ??
      process.env.AUTOKIMI_HOME ??
      process.env.KIMI_CODE_HOME ??
      join(homedir(), '.kimi-code'),
  );
  const work = resolve(
    options.workRoot ?? join(home, 'autokimi', 'update-work', randomUUID()),
  );
  const source = join(work, 'autokimi');
  const reportPath = join(work, 'project-update.json');
  const report = {
    status: 'running',
    stage: 'source',
    repository: REPOSITORY,
    reportPath,
  };
  await mkdir(work, { recursive: true });
  try {
    await (dependencies.checkout ?? checkoutProject)(source, options.revision);
    assert.equal(
      (await readJson(join(source, 'package.json'))).name,
      'autokimi',
    );
    await (dependencies.check ?? checkRepo)(source);
    report.autoKimi = await (dependencies.identity ?? projectIdentity)(source);
    assert.match(
      report.autoKimi.revision,
      /^[a-f0-9]{40}$/,
      'Missing source revision',
    );
    assert.equal(report.autoKimi.dirty, false, 'Update source has local edits');
    report.stage = 'candidate';
    const args = [
      'tools/follow-upstream.mjs',
      '--home',
      home,
      '--work-root',
      join(work, 'runtime'),
    ];
    if (options.upgrade) args.push('--upgrade');
    else if (options.install) args.push('--install');
    for (const [key, value] of Object.entries({
      version: options.version,
      'store-dir':
        options.storeDir === undefined ? undefined : resolve(options.storeDir),
      'cdn-base': options.cdnBase,
    }))
      if (value !== undefined) args.push('--' + key, value);
    (dependencies.run ?? run)(process.execPath, args, { cwd: source });
    report.runtime = await readJson(join(work, 'runtime', 'report.json'));
    report.status = report.runtime.status;
    report.stage = 'complete';
    return report;
  } catch (error) {
    report.runtime = await readJson(join(work, 'runtime', 'report.json')).catch(
      () => undefined,
    );
    report.status = report.runtime?.partial ? 'partial' : 'failed';
    report.error = String(error);
    throw error;
  } finally {
    try {
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', {
        mode: 0o600,
      });
    } catch (error) {
      if (
        !report.runtime?.autoKimiInstalled &&
        report.runtime?.officialStatus !== 'updated'
      )
        throw error;
      report.cleanupWarning =
        'Update took effect; project report could not be written: ' +
        String(error);
    }
  }
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      revision: { type: 'string' },
      install: { type: 'boolean' },
      upgrade: { type: 'boolean' },
      home: { type: 'string' },
      'work-root': { type: 'string' },
      'store-dir': { type: 'string' },
      'cdn-base': { type: 'string' },
      identity: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.identity) {
    const manifest = await readJson(values.identity);
    console.log(
      `AutoKimi ${manifest.autoKimi.version} (${manifest.autoKimi.revision ?? 'source archive'}${manifest.autoKimi.dirty ? ', modified' : ''})\nSource SHA-256: ${manifest.autoKimi.sourceSha256}\nKimi ${manifest.version}`,
    );
  } else if (values.help) {
    console.log(
      'Usage: autokimi update [--install] [--revision <AutoKimi commit>] [--version <Kimi version>]\n       autokimi upgrade [--revision <AutoKimi commit>] [--version <Kimi version>]\n\nFetches current AutoKimi main before building with its patches. --revision pins the AutoKimi source.\nWithout --install, only build and validate a candidate.\nupgrade validates AutoKimi first, then upgrades official Kimi when needed and installs AutoKimi.\nUse autokimi --version to identify both AutoKimi source and Kimi versions.',
    );
  } else {
    console.log(
      JSON.stringify(
        await updateProject({
          version: values.version,
          revision: values.revision,
          install: values.install,
          upgrade: values.upgrade,
          home: values.home,
          workRoot: values['work-root'],
          storeDir: values['store-dir'],
          cdnBase: values['cdn-base'],
        }),
        null,
        2,
      ),
    );
  }
}
