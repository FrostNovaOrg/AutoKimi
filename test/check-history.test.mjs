import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkHistory } from '../tools/check-history.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'autokimi-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Example',
    GIT_COMMITTER_NAME: 'Example',
    GIT_AUTHOR_EMAIL: 'example@example.test',
    GIT_COMMITTER_EMAIL: 'example@example.test',
  };
  const git = (...args) =>
    execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--initial-branch=main');
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-m', message);
  };
  await writeFile(join(root, 'README.md'), 'clean source\n');
  commit('Initial');
  return { root, git, commit };
}

test('finds forbidden text in a removed file, commit message and secondary branch', async (t) => {
  const f = await fixture(t);
  f.git('checkout', '-b', 'old-branch');
  await writeFile(join(f.root, 'example.txt'), 'FORBIDDEN-MODEL\n');
  f.commit('Mention forbidden-model');
  await rm(join(f.root, 'example.txt'));
  f.commit('Remove example');
  f.git('checkout', 'main');
  const result = checkHistory({ root: f.root, patterns: ['forbidden-model'] });
  assert.equal(result.clean, false);
  assert.equal(result.commits, 3);
  assert.ok(result.findings.some((finding) => finding.type === 'commit'));
  assert.ok(result.findings.some((finding) => finding.type === 'blob'));
  assert.equal(
    JSON.stringify(result).toLowerCase().includes('forbidden-model'),
    false,
  );
});

test('detects a credential in historical content without echoing it', async (t) => {
  const f = await fixture(t);
  const token = 'ghp_' + 'x'.repeat(40);
  await writeFile(join(f.root, 'example.txt'), token);
  f.commit('Fixture token');
  await rm(join(f.root, 'example.txt'));
  f.commit('Remove token');
  const result = checkHistory({ root: f.root });
  assert.equal(result.clean, false);
  assert.match(result.findings[0].rule, /credential/);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('audits tags and refuses a shallow clone that cannot prove complete history', async (t) => {
  const f = await fixture(t);
  f.git('tag', '-a', 'v0.1.0', '-m', 'forbidden-tag');
  assert.equal(
    checkHistory({ root: f.root, patterns: ['forbidden-tag'] }).clean,
    false,
  );
  const clone = f.root + '-shallow';
  t.after(() => rm(clone, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--depth=1', 'file://' + f.root, clone], {
    stdio: 'pipe',
  });
  assert.throws(() => checkHistory({ root: clone }), /complete history/);
});
