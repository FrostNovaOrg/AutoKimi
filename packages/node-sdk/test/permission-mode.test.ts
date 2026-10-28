import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKimiHarness } from '#/index';
import { PermissionModeSchema } from '#/config/schema';
import { TEST_IDENTITY } from './test-identity';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-review-permission-'));
  directories.push(homeDir);
  const workDir = join(homeDir, 'project');
  await mkdir(workDir);
  const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
  await harness.setConfig({
    providers: { fixture: { type: 'openai', apiKey: 'fixture', baseUrl: 'https://example.test/v1' } },
    models: { fixture: { provider: 'fixture', model: 'fixture', maxContextSize: 8192 } },
    defaultModel: 'fixture',
    experimental: { approval_review: true },
  });
  return { homeDir, workDir, harness };
}

describe('native Auto Review permission mode', () => {
  it('round trips all four modes and writes the native default key', async () => {
    const { homeDir, workDir, harness } = await fixture();
    try {
      await harness.setConfig({ defaultPermissionMode: 'review' });
      expect((await harness.getConfig()).defaultPermissionMode).toBe('review');
      const session = await harness.createSession({ workDir });
      expect((await session.getStatus()).permission).toBe('review');
      expect(session.summary?.sessionDir).toContain(join(homeDir, 'sessions'));
      for (const mode of ['manual', 'review', 'yolo', 'auto'] as const) {
        expect(PermissionModeSchema.parse(mode)).toBe(mode);
        await session.setPermission(mode);
        expect((await session.getStatus()).permission).toBe(mode);
      }
      const text = await readFile(join(homeDir, 'config.toml'), 'utf8');
      expect(text).toMatch(/default_permission_mode\s*=\s*"review"/);
      expect(text).not.toContain('autokimi_permission_mode');
    } finally {
      await harness.close();
    }
  });

  it('does not enable review merely because its capability is available', async () => {
    const { workDir, harness } = await fixture();
    try {
      const session = await harness.createSession({ workDir });
      expect((await session.getStatus()).permission).toBe('manual');
    } finally {
      await harness.close();
    }
  });

  it('rejects an invalid native default before creating a task', async () => {
    const { homeDir, workDir, harness } = await fixture();
    try {
      const config = join(homeDir, 'config.toml');
      await writeFile(config, 'default_permission_mode = "invalid-mode"\n' + await readFile(config, 'utf8'));
      await harness.getConfig({ reload: true });
      await expect(harness.createSession({ workDir, model: 'fixture' })).rejects.toThrow('Invalid default_permission_mode');
    } finally {
      await harness.close();
    }
  });

  it('rejects selecting review while the capability is disabled', async () => {
    const { workDir, harness } = await fixture();
    try {
      await harness.setConfig({ experimental: { approval_review: false } });
      const session = await harness.createSession({ workDir });
      await expect(session.setPermission('review')).rejects.toThrow('Auto Review is unavailable');
      expect((await session.getStatus()).permission).toBe('manual');
      await expect(harness.createSession({ workDir, permission: 'review' })).rejects.toThrow('Auto Review is unavailable');
    } finally {
      await harness.close();
    }
  });

  it('preserves a manual choice when the session is restored with review available', async () => {
    const { homeDir, workDir, harness } = await fixture();
    const session = await harness.createSession({ workDir, permission: 'review' });
    const id = session.id;
    await session.setPermission('manual');
    await harness.close();
    const resumed = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    try {
      expect((await (await resumed.resumeSession({ id })).getStatus()).permission).toBe('manual');
    } finally {
      await resumed.close();
    }
  });

  it('restores review in the existing session directory', async () => {
    const { homeDir, workDir, harness } = await fixture();
    const session = await harness.createSession({ workDir, permission: 'review' });
    const id = session.id;
    await harness.close();
    const resumed = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    try {
      const restored = await resumed.resumeSession({ id });
      expect((await restored.getStatus()).permission).toBe('review');
      expect(restored.summary?.sessionDir).toContain(join(homeDir, 'sessions'));
    } finally {
      await resumed.close();
    }
  });

  it('keeps an older manual session without a permission event when the new default is review', async () => {
    const { homeDir, workDir, harness } = await fixture();
    const session = await harness.createSession({ workDir, permission: 'manual' });
    const id = session.id;
    const wire = join(session.summary!.sessionDir!, 'agents', 'main', 'wire.jsonl');
    await harness.close();
    const records = (await readFile(wire, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    expect(records.some((record) => record.type === 'permission.set_mode')).toBe(true);
    await writeFile(wire, records.filter((record) => record.type !== 'permission.set_mode').map((record) => JSON.stringify(record)).join('\n') + '\n');
    const resumed = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    try {
      await resumed.setConfig({ defaultPermissionMode: 'review' });
      expect((await (await resumed.resumeSession({ id })).getStatus()).permission).toBe('manual');
      expect((await (await resumed.createSession({ workDir, model: 'fixture' })).getStatus()).permission).toBe('review');
    } finally {
      await resumed.close();
    }
  });

  it('requires review when a budgeted headless task restores a Never Ask session', async () => {
    const { homeDir, workDir, harness } = await fixture();
    const session = await harness.createSession({ workDir, permission: 'auto' });
    const id = session.id;
    await harness.close();
    const headless = createKimiHarness({
      homeDir,
      identity: TEST_IDENTITY,
      headless: {
        limits: { maxSteps: 10, maxRequests: 20, maxTools: 20, maxTokens: 10000, timeoutMs: 30000 },
        initial: { steps: 0, requests: 0, tools: 0, tokens: 0, elapsedMs: 0, denials: 0, consecutiveDenials: 0, recentDenials: [] },
        workDir,
        readOnly: false,
        allowNetwork: false,
        onUpdate: () => {},
      },
    });
    try {
      const restored = await headless.resumeSession({ id });
      expect((await restored.getStatus()).permission).toBe('review');
      await expect(restored.setPermission('auto')).rejects.toThrow('review_disabled');
    } finally {
      await headless.close();
    }
  });
});
