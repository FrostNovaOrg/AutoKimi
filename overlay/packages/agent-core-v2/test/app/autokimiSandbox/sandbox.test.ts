import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutoKimiSandbox,
  protectedShellPaths,
} from '#/app/autokimiSandbox/sandbox';

const roots: string[] = [];
function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'autokimi-shell-boundary-')),
  );
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  mkdirSync(home);
  mkdirSync(cwd);
  return { home, cwd };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('shell boundary discovery', () => {
  it('protects runtime storage and instruction paths above and within the workspace', () => {
    const { home, cwd } = fixture();
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'AGENTS.md'), 'instructions');
    const paths = protectedShellPaths(cwd, home);
    expect(paths).toContain(home);
    expect(paths).toContain(join(cwd, 'src', 'AGENTS.md'));
    expect(paths).toContain(join(cwd, 'AGENTS.md'));
  });
  it('refuses preexisting hardlink aliases to runtime configuration', () => {
    const { home, cwd } = fixture();
    writeFileSync(join(home, 'config.toml'), 'synthetic');
    linkSync(join(home, 'config.toml'), join(cwd, 'notes.md'));
    expect(() => protectedShellPaths(cwd, home)).toThrow('hard links');
  });
  it('refuses preexisting hardlink aliases to project instructions', () => {
    const { home, cwd } = fixture();
    writeFileSync(join(cwd, 'AGENTS.md'), 'instructions');
    linkSync(join(cwd, 'AGENTS.md'), join(cwd, 'notes.md'));
    expect(() => protectedShellPaths(cwd, home)).toThrow('hard-link');
  });
});

it('retains an explicit TUI opt-out while requiring the sandbox for headless tasks', async () => {
  const { home, cwd } = fixture();
  const sandbox = new AutoKimiSandbox(
    { homeDir: home } as IBootstrapService,
    {
      get: () => ({ review: { shellSandbox: false } }),
    } as unknown as IConfigService,
  );
  try {
    expect(
      await sandbox.wrap(
        'printf synthetic',
        cwd,
        '/bin/sh',
        new AbortController().signal,
        false,
      ),
    ).toBeUndefined();
    await expect(
      sandbox.wrap(
        'printf synthetic',
        cwd,
        '/bin/sh',
        new AbortController().signal,
        false,
        true,
      ),
    ).rejects.toThrow('required');
  } finally {
    sandbox.dispose();
  }
});
it('fails closed when the operating-system sandbox cannot initialize', async () => {
  const { home, cwd } = fixture();
  const initialize = vi
    .spyOn(SandboxManager, 'initialize')
    .mockRejectedValue(new Error('synthetic missing dependency'));
  const sandbox = new AutoKimiSandbox(
    { homeDir: home } as IBootstrapService,
    { get: () => ({}) } as unknown as IConfigService,
  );
  try {
    await expect(
      sandbox.wrap(
        'printf synthetic',
        cwd,
        '/bin/sh',
        new AbortController().signal,
        false,
      ),
    ).rejects.toThrow('shell was not started');
  } finally {
    sandbox.dispose();
    initialize.mockRestore();
  }
});

it('protects the real target of a linked runtime configuration', () => {
  const { home, cwd } = fixture();
  const target = join(cwd, 'settings.toml');
  writeFileSync(target, 'synthetic');
  symlinkSync(target, join(home, 'config.toml'));
  const reads = new Set<string>();
  const writes = protectedShellPaths(cwd, home, reads);
  expect(writes).toContain(target);
  expect(reads.has(target)).toBe(true);
});
it('protects a dangling runtime alias before a shell can create its target', () => {
  const { home, cwd } = fixture();
  const target = join(cwd, 'future-settings.toml');
  symlinkSync(target, join(home, 'config.toml'));
  expect(protectedShellPaths(cwd, home)).toContain(target);
});
