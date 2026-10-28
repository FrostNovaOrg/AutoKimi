import { configToTomlData } from '#/config/toml';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KimiConfigPatchSchema,
  loadRuntimeConfigSafe,
  parseConfigString,
} from '#/config/index';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe('approval review config safety', () => {
  it('keeps permission rules and invalid reviewer data in safe runtime loads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-review-config-'));
    tempDirs.push(dir);
    const file = join(dir, 'config.toml');
    const text = `
[permission]
rules = [{ decision = "deny", pattern = "Write" }]
[permission.review]
timeout_ms = 0
`;
    await writeFile(file, text);
    const result = loadRuntimeConfigSafe(file);
    expect(result.config.permission?.rules).toMatchObject([
      { decision: 'deny', pattern: 'Write' },
    ]);
    expect(result.config.permission?.review).toMatchObject({
      timeoutMs: 0,
    });
    expect(() => parseConfigString(text)).toThrow();
  });

  it('stores review defaults in the AutoKimi key when serializing SDK config', () => {
    const data = configToTomlData({
      providers: {},
      defaultPermissionMode: 'review',
      raw: { default_permission_mode: 'yolo' },
    });
    expect(data['autokimi_permission_mode']).toBe('review');
    expect(data['default_permission_mode']).toBe('yolo');
  });

  it('parses reviewer patches without materializing defaults', () => {
    expect(
      KimiConfigPatchSchema.parse({
        permission: { review: { model: 'provider/reviewer' } },
      }),
    ).toEqual({
      permission: { review: { model: 'provider/reviewer' } },
    });
  });
});
