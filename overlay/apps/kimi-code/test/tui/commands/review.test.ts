import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExperimentalFeatureState,
  KimiConfigPatch,
} from '@moonshot-ai/kimi-code-sdk';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleReviewCommand } from '#/tui/commands/review';
import {
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
} from '#/tui/commands/experimental-flags';

function makeHost(source: ExperimentalFeatureState['source'] = 'default') {
  let enabled = false;
  const feature = (): ExperimentalFeatureState => ({
    id: 'approval_review',
    title: 'Model approval reviewer',
    description: 'Review',
    surface: 'core',
    env: 'KIMI_CODE_EXPERIMENTAL_APPROVAL_REVIEW',
    defaultEnabled: false,
    enabled,
    source,
  });
  const host = {
    state: { appState: { permissionMode: 'auto' } },
    session: { setPermission: vi.fn(async () => {}) },
    harness: {
      getExperimentalFeatures: vi.fn(async () => [feature()]),
      getConfig: vi.fn(async () => ({
        providers: {},
        permission: {
          review: { timeoutMs: 45000, maxContextChars: 12000, twoStage: false },
        },
      })),
      setConfig: vi.fn(async (patch: KimiConfigPatch) => {
        if (patch.experimental !== undefined)
          enabled = patch.experimental['approval_review'] === true;
        return { providers: {} };
      }),
    },
    setAppState: vi.fn(),
    showNotice: vi.fn(),
    showError: vi.fn(),
    refreshSlashCommandAutocomplete: vi.fn(),
  };
  return { host, commandHost: host as unknown as SlashCommandHost };
}

describe('native TUI approval reviewer', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('enables the reviewer and switches the active and future sessions to manual permissions', async () => {
    const t = makeHost();
    await handleReviewCommand(t.commandHost, 'on');
    expect(t.host.session.setPermission).toHaveBeenCalledWith('manual');
    expect(t.host.harness.setConfig).toHaveBeenCalledWith({
      defaultPermissionMode: 'manual',
      experimental: { approval_review: true },
    });
    expect(t.host.setAppState).toHaveBeenCalledWith({
      permissionMode: 'manual',
    });
    expect(isExperimentalFlagEnabled('approval_review')).toBe(true);
    expect(t.host.showNotice).toHaveBeenCalledWith(
      'Auto-review: ON',
      expect.stringContaining('without a permission prompt'),
    );
  });

  it('disables review without granting broader permissions', async () => {
    const t = makeHost();
    await handleReviewCommand(t.commandHost, 'off');
    expect(t.host.harness.setConfig).toHaveBeenCalledWith({
      experimental: { approval_review: false },
    });
    expect(t.host.session.setPermission).not.toHaveBeenCalled();
  });

  it('does not claim to disable an environment-enforced reviewer', async () => {
    const t = makeHost('env');
    await handleReviewCommand(t.commandHost, 'off');
    expect(t.host.harness.setConfig).not.toHaveBeenCalled();
    expect(t.host.showError).toHaveBeenCalledWith(
      expect.stringContaining('environment override'),
    );
  });

  it('reports bypass modes as paused and preserves tuning when changing models', async () => {
    const t = makeHost();
    await handleReviewCommand(t.commandHost, 'on');
    await handleReviewCommand(t.commandHost, 'status');
    expect(t.host.showNotice).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Paused'),
    );
    await handleReviewCommand(t.commandHost, 'model provider/reviewer');
    expect(t.host.harness.setConfig).toHaveBeenCalledWith({
      permission: {
        review: {
          model: 'provider/reviewer',
          timeoutMs: 45000,
          maxContextChars: 12000,
          twoStage: false,
        },
      },
    });
  });

  it('describes uncertain and failed reviews as denials in active mode', async () => {
    const t = makeHost();
    await handleReviewCommand(t.commandHost, 'on');
    t.host.state.appState.permissionMode = 'manual';
    await handleReviewCommand(t.commandHost, 'status');
    expect(t.host.showNotice).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('uncertain or failed reviews deny'),
    );
  });

  it('reports disabled review without claiming to review or deny actions', async () => {
    const t = makeHost();
    await handleReviewCommand(t.commandHost, 'status');
    expect(t.host.showNotice).toHaveBeenCalledWith(
      expect.stringContaining('OFF'),
      expect.stringContaining('Disabled'),
    );
  });
});
