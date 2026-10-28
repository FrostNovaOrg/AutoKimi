import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createKimiHarness,
  importKimiSession,
  listLegacyKimiSessions,
} from '#/index';
import { PermissionModeSchema } from '#/config/schema';
import { TEST_IDENTITY } from './test-identity';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), 'autokimi-permission-'));
  directories.push(homeDir);
  const workDir = join(homeDir, 'project');
  await mkdir(workDir);
  const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
  await harness.setConfig({
    providers: {
      fixture: {
        type: 'openai',
        apiKey: 'fixture',
        baseUrl: 'https://example.test/v1',
      },
    },
    models: {
      fixture: { provider: 'fixture', model: 'fixture', maxContextSize: 8192 },
    },
    defaultModel: 'fixture',
    experimental: { approval_review: true },
  });
  return { homeDir, workDir, harness };
}

describe('native Auto Review permission mode', () => {
  it('round trips all four modes through the SDK and keeps the native config compatible', async () => {
    const { homeDir, workDir, harness } = await fixture();
    try {
      await writeFile(
        join(homeDir, 'config.toml'),
        'default_permission_mode = "manual"\n' +
          (await readFile(join(homeDir, 'config.toml'), 'utf8')),
      );
      await harness.getConfig({ reload: true });
      await harness.setConfig({ defaultPermissionMode: 'review' });
      expect((await harness.getConfig()).defaultPermissionMode).toBe('review');
      const session = await harness.createSession({
        workDir,
        permission: 'review',
      });
      for (const mode of ['manual', 'review', 'yolo', 'auto'] as const) {
        expect(PermissionModeSchema.parse(mode)).toBe(mode);
        await session.setPermission(mode);
        expect((await session.getStatus()).permission).toBe(mode);
      }
      const text = await readFile(join(homeDir, 'config.toml'), 'utf8');
      expect(text).toMatch(/autokimi_permission_mode\s*=\s*"review"/);
      expect(text).not.toMatch(/default_permission_mode\s*=\s*"review"/);
      await harness.setConfig({ defaultPermissionMode: 'manual' });
      expect((await harness.getConfig()).defaultPermissionMode).toBe('manual');
      expect(session.summary?.sessionDir).toContain(
        join(homeDir, 'autokimi', 'sessions'),
      );
    } finally {
      await harness.close();
    }
  });

  it('keeps an explicit manual choice after review is switched off and the session is resumed', async () => {
    const { homeDir, workDir, harness } = await fixture();
    const session = await harness.createSession({
      workDir,
      permission: 'review',
      metadata: { autokimi: { approvalReview: true } },
    });
    const id = session.id;
    await session.setPermission('manual');
    await harness.close();
    const resumed = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    try {
      expect(
        (await (await resumed.resumeSession({ id })).getStatus()).permission,
      ).toBe('manual');
    } finally {
      await resumed.close();
    }
  });

  it('requires review from headless bootstrap even when the saved session used Never Ask', async () => {
    const { homeDir, workDir, harness } = await fixture();
    const session = await harness.createSession({
      workDir,
      permission: 'auto',
    });
    const id = session.id;
    await harness.close();
    const headless = createKimiHarness({
      homeDir,
      identity: TEST_IDENTITY,
      headless: {
        limits: {
          maxSteps: 10,
          maxRequests: 20,
          maxTools: 20,
          maxTokens: 10000,
          timeoutMs: 30000,
        },
        initial: {
          steps: 0,
          requests: 0,
          tools: 0,
          tokens: 0,
          elapsedMs: 0,
          denials: 0,
          consecutiveDenials: 0,
          recentDenials: [],
        },
        workDir,
        readOnly: false,
        allowNetwork: false,
        onUpdate: () => {},
      },
    });
    try {
      const resumed = await headless.resumeSession({ id });
      expect((await resumed.getStatus()).permission).toBe('review');
      await expect(resumed.setPermission('auto')).rejects.toThrow();
    } finally {
      await headless.close();
    }
  });

  it('migrates a legacy review session once, on its imported copy', async () => {
    const { homeDir, workDir, harness } = await fixture();
    const session = await harness.createSession({
      workDir,
      permission: 'manual',
      metadata: { autokimi: { approvalReview: true } },
    });
    const id = session.id;
    const sourceDir = session.summary!.sessionDir;
    await session.importContext(
      'Retain the migration task context sentinel.',
      'migration fixture',
    );
    await harness.close();
    const wire = join(sourceDir, 'agents', 'main', 'wire.jsonl');
    const oldWire =
      (await readFile(wire, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => {
          const event = JSON.parse(line);
          if (event.type === 'permission.set_mode') delete event.version;
          return JSON.stringify(event);
        })
        .join('\n') + '\n';
    await writeFile(wire, oldWire);
    const workspace = sourceDir.split('/').at(-2)!;
    await mkdir(join(homeDir, 'sessions', workspace), { recursive: true });
    const legacyDir = join(homeDir, 'sessions', workspace, id);
    await rename(sourceDir, legacyDir);
    expect(
      (await listLegacyKimiSessions(homeDir)).map((entry) => entry.id),
    ).toContain(id);
    const legacyClient = createKimiHarness({
      homeDir,
      identity: TEST_IDENTITY,
    });
    try {
      await expect(legacyClient.resumeSession({ id })).rejects.toThrow(
        'autokimi session import',
      );
    } finally {
      await legacyClient.close();
    }
    await importKimiSession(homeDir, id);
    const resumed = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    try {
      const imported = await resumed.resumeSession({ id });
      expect((await imported.getStatus()).permission).toBe('review');
      expect(JSON.stringify(await imported.getContext())).toContain(
        'Retain the migration task context sentinel.',
      );
      await imported.setPermission('manual');
    } finally {
      await resumed.close();
    }
    expect(
      await readFile(join(legacyDir, 'agents', 'main', 'wire.jsonl'), 'utf8'),
    ).toBe(oldWire);
    await expect(importKimiSession(homeDir, id)).rejects.toThrow(
      'already exists',
    );
  });

  it('refuses active sources, path traversal, and linked session files', async () => {
    const { homeDir, workDir, harness } = await fixture();
    const session = await harness.createSession({
      workDir,
      permission: 'manual',
    });
    const id = session.id,
      source = session.summary!.sessionDir,
      workspace = source.split('/').at(-2)!;
    await harness.close();
    await mkdir(join(homeDir, 'sessions', workspace), { recursive: true });
    const legacy = join(homeDir, 'sessions', workspace, id);
    await rename(source, legacy);
    await mkdir(join(homeDir, 'locks', 'sessions'), { recursive: true });
    const lock = join(homeDir, 'locks', 'sessions', `${id}.lock`);
    await writeFile(lock, 'active');
    await expect(importKimiSession(homeDir, id)).rejects.toThrow(
      'Close the source',
    );
    await rm(lock);
    await expect(importKimiSession(homeDir, '../outside')).rejects.toThrow(
      'path component',
    );
    const targetLocks = join(homeDir, 'autokimi', 'locks', 'sessions');
    await mkdir(targetLocks, { recursive: true });
    await writeFile(join(targetLocks, `${id}.lock`), 'active');
    await expect(importKimiSession(homeDir, id)).rejects.toThrow('busy');
    await rm(join(targetLocks, `${id}.lock`));
    await symlink(join(homeDir, 'config.toml'), join(legacy, 'linked-config'));
    await expect(importKimiSession(homeDir, id)).rejects.toThrow(
      'links and special files',
    );
    await expect(
      readFile(join(targetLocks, `${id}.lock`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(join(legacy, 'linked-config'));
    await link(join(homeDir, 'config.toml'), join(legacy, 'linked-config'));
    await expect(importKimiSession(homeDir, id)).rejects.toThrow(
      'links and special files',
    );
  });
});
