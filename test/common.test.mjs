import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { isMain, pnpmEnvironment, run } from '../tools/common.mjs';

test('pnpmEnvironment resolves executable overrides before changing cwd', (t) => {
  const previousOverride = process.env.AUTOKIMI_PNPM;
  const previousPath = process.env.PATH;
  t.after(() => {
    if (previousOverride === undefined) delete process.env.AUTOKIMI_PNPM;
    else process.env.AUTOKIMI_PNPM = previousOverride;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const override = join('relative-bin', 'pnpm');
  process.env.AUTOKIMI_PNPM = override;
  process.env.PATH = join('original-bin');
  const { command, env } = pnpmEnvironment();
  assert.equal(command, resolve(override));
  assert.equal(env.PATH, dirname(command) + delimiter + process.env.PATH);
  process.env.AUTOKIMI_PNPM = 'pnpm-custom';
  assert.equal(pnpmEnvironment().command, 'pnpm-custom');
});

test('run captures output larger than the default child process buffer', () => {
  const output = run(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
    { capture: true },
  );
  assert.equal(output.length, 2 * 1024 * 1024);
});

test('isMain recognizes an entry through a symlinked parent', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'autokimi-main-test-'));
  const file = join(directory, 'entry.mjs');
  await writeFile(file, 'export {};\n');
  const alias = join(directory, 'alias');
  await symlink(directory, alias);
  const previous = process.argv[1];
  process.argv[1] = join(alias, 'entry.mjs');
  t.after(async () => {
    process.argv[1] = previous;
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(isMain(pathToFileURL(file).href), true);
});
