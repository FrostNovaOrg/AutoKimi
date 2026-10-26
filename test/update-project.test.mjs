import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkoutProject, updateProject } from '../tools/update-project.mjs';
import { readJson, run } from '../tools/common.mjs';
import { projectIdentity } from '../tools/project-identity.mjs';

async function fixture(t, partial = false) {
  const root = await mkdtemp(join(tmpdir(), 'autokimi-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'new-project');
  await mkdir(join(source, 'tools'), { recursive: true });
  await writeFile(
    join(source, 'package.json'),
    '{"name":"autokimi","version":"0.2.0","type":"module"}\n',
  );
  await writeFile(
    join(source, 'upstream.lock.json'),
    JSON.stringify({
      repository: 'https://github.com/MoonshotAI/kimi-code.git',
      tag: '@moonshot-ai/kimi-code@2.3.0',
      version: '2.3.0',
      commit: 'a'.repeat(40),
      patches: [],
    }),
  );
  await writeFile(
    join(source, 'tools', 'follow-upstream.mjs'),
    `import{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';const args=process.argv.slice(2);const work=args[args.indexOf('--work-root')+1];await mkdir(work,{recursive:true});await writeFile(join(work,'report.json'),JSON.stringify({status:${partial ? "'partial'" : "'candidate'"},partial:${partial},marker:'fresh-patches',cwd:process.cwd(),args}));${partial ? 'process.exitCode=1;' : ''}\n`,
  );
  run('git', ['init', '-q', source]);
  run('git', ['-C', source, 'add', '.']);
  run('git', [
    '-C',
    source,
    '-c',
    'user.name=Example Maintainer',
    '-c',
    'user.email=maintainer@example.test',
    'commit',
    '-qm',
    'New patches',
  ]);
  const checkout = async (destination) =>
    run('git', ['clone', '-q', source, destination]);
  return {
    root,
    source,
    checkout,
    workRoot: join(root, 'update'),
    home: join(root, 'home'),
  };
}

test('installed updater executes fresh project tools and records its exact revision', async (t) => {
  const f = await fixture(t);
  const report = await updateProject(
    { ...f, install: true, version: '2.3.2', storeDir: 'example-store' },
    { checkout: f.checkout },
  );
  assert.equal(report.status, 'candidate');
  assert.equal(report.runtime.marker, 'fresh-patches');
  assert.equal(
    report.runtime.cwd,
    await realpath(join(f.workRoot, 'autokimi')),
  );
  assert.ok(report.runtime.args.includes('--install'));
  assert.ok(report.runtime.args.includes('2.3.2'));
  assert.equal(
    report.runtime.args[report.runtime.args.indexOf('--store-dir') + 1],
    join(process.cwd(), 'example-store'),
  );
  assert.equal(
    report.autoKimi.revision,
    (await projectIdentity(f.source)).revision,
  );
  assert.equal(report.autoKimi.dirty, false);
  assert.deepEqual(await readJson(report.reportPath), report);
});

test('upgrade preserves official-upgrade intent and default update does not install', async (t) => {
  const f = await fixture(t);
  const normal = await updateProject(f, { checkout: f.checkout });
  assert.ok(!normal.runtime.args.includes('--install'));
  assert.ok(!normal.runtime.args.includes('--upgrade'));
  const upgrade = await updateProject(
    { ...f, upgrade: true, workRoot: join(f.root, 'upgrade') },
    { checkout: f.checkout },
  );
  assert.ok(upgrade.runtime.args.includes('--upgrade'));
});

test('failed project fetch cannot start candidate tools', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    updateProject(f, {
      checkout: async () => {
        throw new Error('fetch failed');
      },
      run: () => assert.fail('candidate must not run'),
    }),
    /fetch failed/,
  );
  assert.equal(
    (await readJson(join(f.workRoot, 'project-update.json'))).stage,
    'source',
  );
});

test('rejects modified update source before execution', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    updateProject(f, {
      checkout: async (destination) => {
        await f.checkout(destination);
        await writeFile(join(destination, 'unexpected.txt'), 'modified');
      },
      run: () => assert.fail('candidate must not run'),
    }),
    /local edits/,
  );
});

test('records partial runtime updates when the child fails after a side effect', async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(updateProject(f, { checkout: f.checkout }));
  const report = await readJson(join(f.workRoot, 'project-update.json'));
  assert.equal(report.status, 'partial');
  assert.equal(report.runtime.partial, true);
});

test('source identity changes for edits without falsely changing the commit', async (t) => {
  const f = await fixture(t);
  const first = await projectIdentity(f.source);
  await writeFile(join(f.source, 'extra.txt'), 'new patch');
  const changed = await projectIdentity(f.source);
  assert.equal(changed.revision, first.revision);
  assert.equal(changed.dirty, true);
  assert.notEqual(changed.sourceSha256, first.sourceSha256);
});

test('revision selection accepts only a full commit before fetching', async () => {
  await assert.rejects(
    checkoutProject('unused', 'main'),
    /full AutoKimi commit SHA/,
  );
});
