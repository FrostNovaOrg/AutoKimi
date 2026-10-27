import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExperimentalFeatureState,
  KimiConfigPatch,
} from '@moonshot-ai/kimi-code-sdk';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { applyPermissionChoice } from '#/tui/commands/config';
import { handleReviewCommand } from '#/tui/commands/review';
import {
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
} from '#/tui/commands/experimental-flags';
import { notePermissionStateChanged } from '#/tui/commands/permission-state';
import {
  approvalReviewDenials,
  clearApprovalReviewDenials,
  effectiveApprovalReview,
  recordApprovalReviewDenial,
  takeApprovalReviewDenial,
  type ApprovalReviewDenial,
} from '#/tui/commands/review-state';

function makeSession() {
  let override: boolean | undefined;
  const session = {
    id: 'session-test',
    workDir: '/workspace',
    setPermission: vi.fn(async () => {}),
    updateMetadata: vi.fn(
      async (patch: { autokimi: { approvalReview: boolean } }) => {
        override = patch.autokimi.approvalReview;
      },
    ),
    getResumeState: () =>
      override === undefined
        ? undefined
        : {
            sessionMetadata: {
              custom: { autokimi: { approvalReview: override } },
            },
          },
  };
  return { session };
}

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
  const session = makeSession().session;
  let onDisplaced: (() => void) | undefined;
  const host = {
    state: {
      ui: { requestRender: vi.fn() },
      terminal: { rows: 24 },
      appState: {
        sessionId: session.id,
        workDir: '/workspace',
        model: 'k2',
        permissionMode: 'auto',
        approvalReviewEnabled: false,
      },
    },
    session,
    harness: {
      getExperimentalFeatures: vi.fn(async () => [feature()]),
      getConfig: vi.fn(async () => ({
        providers: {},
        models: {
          'provider/reviewer': { provider: 'example', model: 'reviewer' },
        },
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
    setAppState: vi.fn(
      (patch: { permissionMode?: string; approvalReviewEnabled?: boolean }) => {
        host.state.appState = { ...host.state.appState, ...patch };
      },
    ),
    sendReviewApproval: vi.fn(async (_session: unknown, _text: string) => {}),
    showNotice: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    refreshSlashCommandAutocomplete: vi.fn(),
    mountEditorReplacement: vi.fn((_panel: unknown, displaced?: () => void) => {
      const previous = onDisplaced;
      onDisplaced = displaced;
      previous?.();
    }),
    restoreEditor: vi.fn(() => {
      const displaced = onDisplaced;
      onDisplaced = undefined;
      displaced?.();
    }),
  };
  return {
    host,
    commandHost: host as unknown as SlashCommandHost,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    makeSession,
  };
}

let denialSequence = 0;

function publishDenials(
  denials: readonly ApprovalReviewDenial[],
  sessionId = 'session-test',
  agentId = 'main',
  sequence = ++denialSequence,
): void {
  const toolCallId = denials.at(-1)?.toolCallId ?? 'review-state';
  recordApprovalReviewDenial({
    sessionId,
    toolCallId,
    customKind: 'approval.review',
    customData: {
      kind: 'one_time_approval_state',
      version: 1,
      agentId,
      toolCallId,
      sequence,
      denials,
    },
  });
}

function registerDenial(
  sessionId = 'session-test',
  toolCallId = 'call-denied',
  agentId = 'main',
  challenge = toolCallId === 'call-denied'
    ? '00000000-0000-4000-8000-000000000000'
    : randomUUID(),
  fingerprint = toolCallId === 'call-denied'
    ? 'a'.repeat(64)
    : createHash('sha256').update(toolCallId).digest('hex'),
): void {
  const denials = approvalReviewDenials(sessionId).filter(
    (record) =>
      record.toolCallId !== toolCallId && record.fingerprint !== fingerprint,
  );
  publishDenials(
    [
      ...denials,
      {
        challenge,
        toolCallId,
        fingerprint,
        reason: 'Needs exact approval',
        toolName: 'Bash',
        args: { command: 'npm test' },
      },
    ],
    sessionId,
    agentId,
  );
}

async function openApprovalPicker(
  t: ReturnType<typeof makeHost>,
  command: 'approve' | 'interactive-approve' = 'approve',
) {
  const pending = handleReviewCommand(t.commandHost, command);
  await vi.waitFor(() =>
    expect(t.host.mountEditorReplacement).toHaveBeenCalledOnce(),
  );
  const picker = t.host.mountEditorReplacement.mock.calls[0]?.[0] as {
    handleInput: (data: string) => void;
    render: (width: number) => string[];
  };
  return { pending, picker };
}

function confirmApproval(picker: {
  handleInput(data: string): void;
  render(width: number): string[];
}): void {
  picker.handleInput('\r');
  picker.render(110);
  picker.handleInput('\x1b[F');
  picker.render(110);
  picker.handleInput('\t');
  picker.handleInput('\r');
}

async function approveId(
  t: ReturnType<typeof makeHost>,
  id: string,
): Promise<void> {
  const count = t.host.mountEditorReplacement.mock.calls.length;
  const pending = handleReviewCommand(t.commandHost, `approve ${id}`);
  await vi.waitFor(() =>
    expect(t.host.mountEditorReplacement.mock.calls.length).toBe(count + 1),
  );
  const picker = t.host.mountEditorReplacement.mock.calls.at(-1)![0] as {
    handleInput(data: string): void;
    render(width: number): string[];
  };
  confirmApproval(picker);
  await pending;
}

describe('native TUI approval reviewer', () => {
  afterEach(() => {
    clearApprovalReviewDenials();
    denialSequence = 0;
    setExperimentalFeatures([]);
  });

  it('enables only the current session and switches permissions to manual', async () => {
    const t = makeHost();
    await handleReviewCommand(t.commandHost, 'on');
    expect(t.host.session.setPermission).toHaveBeenCalledWith('manual');
    expect(t.host.harness.setConfig).not.toHaveBeenCalled();
    expect(t.host.session.updateMetadata).toHaveBeenCalledWith({
      autokimi: { approvalReview: true },
    });
    expect(isExperimentalFlagEnabled('approval_review')).toBe(false);
    expect(t.host.state.appState.approvalReviewEnabled).toBe(true);
    expect(t.host.showNotice).toHaveBeenCalledWith(
      'Auto-review: ON',
      expect.stringContaining('without a permission prompt'),
    );
  });

  it('disables only the current session without granting broader permissions', async () => {
    const t = makeHost();
    t.setEnabled(true);
    await handleReviewCommand(t.commandHost, 'off');
    expect(t.host.session.updateMetadata).toHaveBeenCalledWith({
      autokimi: { approvalReview: false },
    });
    expect(t.host.harness.setConfig).not.toHaveBeenCalled();
    expect(t.host.session.setPermission).not.toHaveBeenCalled();
    expect(isExperimentalFlagEnabled('approval_review')).toBe(true);
    expect(t.host.state.appState.approvalReviewEnabled).toBe(false);
  });

  it('does not claim to disable an environment-enforced reviewer', async () => {
    const t = makeHost('env');
    await handleReviewCommand(t.commandHost, 'off');
    expect(t.host.harness.setConfig).not.toHaveBeenCalled();
    expect(t.host.session.updateMetadata).not.toHaveBeenCalled();
    expect(t.host.showError).toHaveBeenCalledWith(
      expect.stringContaining('environment override'),
    );
  });

  it('reports bypass modes as paused and patches only the reviewer model', async () => {
    const t = makeHost();
    await handleReviewCommand(t.commandHost, 'on');
    t.host.state.appState.permissionMode = 'auto';
    await handleReviewCommand(t.commandHost, 'status');
    expect(t.host.showNotice).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Paused'),
    );
    t.host.harness.getConfig.mockClear();
    await handleReviewCommand(t.commandHost, 'model provider/reviewer');
    expect(t.host.harness.setConfig).toHaveBeenCalledWith({
      permission: { review: { model: 'provider/reviewer' } },
    });
    expect(t.host.harness.getConfig).toHaveBeenCalled();
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

  it('does not overwrite a later auto permission change while enabling', async () => {
    const t = makeHost();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    t.host.session.setPermission.mockImplementationOnce(async () => {
      await blocked;
    });
    const pending = handleReviewCommand(t.commandHost, 'on');
    await vi.waitFor(() =>
      expect(t.host.session.setPermission).toHaveBeenCalled(),
    );
    t.host.state.appState = {
      ...t.host.state.appState,
      permissionMode: 'auto',
    };
    notePermissionStateChanged();
    finish();
    await pending;
    expect(t.host.setAppState).not.toHaveBeenCalledWith({
      permissionMode: 'manual',
    });
    expect(t.host.showNotice).toHaveBeenCalledWith(
      'Auto-review: ON',
      expect.stringContaining('paused'),
    );
  });

  it('does not update a replacement session after enabling completes', async () => {
    const t = makeHost();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    t.host.session.setPermission.mockImplementationOnce(async () => {
      await blocked;
    });
    const pending = handleReviewCommand(t.commandHost, 'on');
    await vi.waitFor(() =>
      expect(t.host.session.setPermission).toHaveBeenCalled(),
    );
    t.host.session = t.makeSession().session;
    finish();
    await pending;
    expect(t.host.setAppState).not.toHaveBeenCalledWith({
      permissionMode: 'manual',
    });
    expect(t.host.showNotice).toHaveBeenCalledWith(
      'Auto-review: OFF',
      expect.stringContaining('selected permission mode'),
    );
  });

  it('forwards a repeated auto choice made while enabling', async () => {
    const t = makeHost();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    t.host.session.setPermission.mockImplementationOnce(async () => {
      await blocked;
    });
    const pending = handleReviewCommand(t.commandHost, 'on');
    await vi.waitFor(() =>
      expect(t.host.session.setPermission).toHaveBeenCalled(),
    );
    try {
      await applyPermissionChoice(t.commandHost, 'auto');
      expect(t.host.session.setPermission).toHaveBeenNthCalledWith(1, 'manual');
      expect(t.host.session.setPermission).toHaveBeenNthCalledWith(2, 'auto');
    } finally {
      finish();
    }
    await pending;
    expect(t.host.harness.setConfig).not.toHaveBeenCalled();
    expect(t.host.state.appState.permissionMode).toBe('auto');
    expect(t.host.setAppState).not.toHaveBeenCalledWith({
      permissionMode: 'manual',
    });
  });

  it('refreshes the footer flag cache when reporting status', async () => {
    const t = makeHost();
    await handleReviewCommand(t.commandHost, 'on');
    t.setEnabled(true);
    setExperimentalFeatures([]);
    expect(isExperimentalFlagEnabled('approval_review')).toBe(false);
    await handleReviewCommand(t.commandHost, 'status');
    expect(isExperimentalFlagEnabled('approval_review')).toBe(true);
  });

  it('keeps another session enabled when the current session is disabled', async () => {
    const t = makeHost();
    t.setEnabled(true);
    const other = t.makeSession().session;
    await handleReviewCommand(t.commandHost, 'off');
    const [feature] = await t.host.harness.getExperimentalFeatures();
    expect(effectiveApprovalReview(t.host.session, feature)).toBe(false);
    expect(effectiveApprovalReview(other, feature)).toBe(true);
  });

  it('lists eligible denials for the current session', async () => {
    const t = makeHost();
    registerDenial();
    registerDenial('other-session', 'other-call');
    await handleReviewCommand(t.commandHost, 'denials');
    expect(t.host.showNotice).toHaveBeenCalledWith(
      'Auto-review denials: 1',
      expect.stringContaining('call-denied Bash: Needs exact approval'),
    );
  });

  it('records a denial when the tool start event is unavailable', async () => {
    const t = makeHost();
    publishDenials([
      {
        challenge: '00000000-0000-4000-8000-000000000000',
        toolCallId: 'call-before-start',
        fingerprint: 'a'.repeat(64),
        reason: 'Before tool start',
        toolName: 'Bash',
        args: { command: 'npm test' },
      },
    ]);
    await handleReviewCommand(t.commandHost, 'denials');
    expect(t.host.showNotice).toHaveBeenCalledWith(
      'Auto-review denials: 1',
      expect.stringContaining('call-before-start Bash: Before tool start'),
    );
  });

  it('reports when no denial is available for an ID-free approval', async () => {
    const t = makeHost();
    t.setEnabled(true);
    t.host.state.appState.permissionMode = 'manual';
    await handleReviewCommand(t.commandHost, 'approve');
    expect(t.host.showNotice).toHaveBeenCalledWith(
      'Auto-review denials: 0',
      'No eligible model denials.',
    );
    expect(t.host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(t.host.sendReviewApproval).not.toHaveBeenCalled();
  });

  it('changes a unique denial to approved and consumes it without an ID', async () => {
    const t = makeHost();
    t.setEnabled(true);
    t.host.state.appState.permissionMode = 'manual';
    registerDenial();
    const { pending, picker } = await openApprovalPicker(
      t,
      'interactive-approve',
    );
    expect(picker.render(110).join('\n')).toContain('Review denied actions');
    confirmApproval(picker);
    await vi.waitFor(() =>
      expect(t.host.sendReviewApproval).toHaveBeenCalledTimes(1),
    );
    const message = t.host.sendReviewApproval.mock.calls[0]?.[1] as string;
    expect(JSON.parse(message.split('\n')[1] ?? '')).toMatchObject({
      toolCallId: 'call-denied',
    });
    await vi.waitFor(() => expect(t.host.restoreEditor).toHaveBeenCalled());
    confirmApproval(picker);
    await pending;
    await handleReviewCommand(t.commandHost, 'approve');
    expect(t.host.sendReviewApproval).toHaveBeenCalledTimes(1);
    expect(t.host.showNotice).toHaveBeenCalledWith(
      'Auto-review denials: 0',
      'No eligible model denials.',
    );
  });

  it('requires an explicit selection for multiple denials and defaults to the latest', async () => {
    const t = makeHost();
    t.setEnabled(true);
    t.host.state.appState.permissionMode = 'manual';
    registerDenial();
    registerDenial(
      'session-test',
      'call-newer',
      'main',
      '00000000-0000-4000-8000-000000000001',
    );
    const { pending, picker } = await openApprovalPicker(t);
    expect(t.host.sendReviewApproval).not.toHaveBeenCalled();
    const rendered = picker.render(110).join('\n');
    expect(rendered).toContain('Review denied actions');
    expect(rendered).toContain('Needs exact approval');
    confirmApproval(picker);
    await vi.waitFor(() =>
      expect(t.host.sendReviewApproval).toHaveBeenCalledTimes(1),
    );
    const message = t.host.sendReviewApproval.mock.calls[0]?.[1] as string;
    expect(JSON.parse(message.split('\n')[1] ?? '')).toMatchObject({
      toolCallId: 'call-newer',
      challenge: '00000000-0000-4000-8000-000000000001',
    });
    expect(t.host.restoreEditor).toHaveBeenCalled();
    confirmApproval(picker);
    await pending;
    expect(t.host.restoreEditor).toHaveBeenCalled();
    expect(approvalReviewDenials('session-test')).toHaveLength(1);
  });

  it('cancels a denial selection without consuming any record', async () => {
    const t = makeHost();
    t.setEnabled(true);
    t.host.state.appState.permissionMode = 'manual';
    registerDenial();
    registerDenial('session-test', 'call-newer');
    const { pending, picker } = await openApprovalPicker(t);
    picker.handleInput('\x1b');
    picker.handleInput('\x1b');
    await pending;
    expect(t.host.sendReviewApproval).not.toHaveBeenCalled();
    expect(t.host.restoreEditor).toHaveBeenCalled();
    expect(approvalReviewDenials('session-test')).toHaveLength(2);
  });

  it('does not approve a selection from a replaced session', async () => {
    const t = makeHost();
    t.setEnabled(true);
    t.host.state.appState.permissionMode = 'manual';
    registerDenial();
    registerDenial('session-test', 'call-newer');
    const { pending, picker } = await openApprovalPicker(t);
    t.host.session = {
      ...t.makeSession().session,
      id: 'session-other',
    } as unknown as typeof t.host.session;
    confirmApproval(picker);
    await vi.waitFor(() =>
      expect(t.host.showError).toHaveBeenCalledWith(
        'The selected auto-review denial is no longer active.',
      ),
    );
    picker.handleInput('\x1b');
    picker.handleInput('\x1b');
    await pending;
    expect(t.host.sendReviewApproval).not.toHaveBeenCalled();
    expect(approvalReviewDenials('session-test')).toHaveLength(2);
  });

  it('does not consume a denial whose challenge changed during selection', async () => {
    const t = makeHost();
    t.setEnabled(true);
    t.host.state.appState.permissionMode = 'manual';
    registerDenial();
    registerDenial('session-test', 'call-newer');
    const { pending, picker } = await openApprovalPicker(t);
    registerDenial(
      'session-test',
      'call-newer',
      'main',
      '00000000-0000-4000-8000-000000000002',
    );
    confirmApproval(picker);
    await vi.waitFor(() =>
      expect(t.host.showError).toHaveBeenCalledWith(
        'No eligible auto-review denial: call-newer',
      ),
    );
    expect(t.host.sendReviewApproval).not.toHaveBeenCalled();
    picker.handleInput('\x1b');
    picker.handleInput('\x1b');
    await pending;
    expect(t.host.sendReviewApproval).not.toHaveBeenCalled();
    expect(
      approvalReviewDenials('session-test').find(
        (record) => record.toolCallId === 'call-newer',
      )?.challenge,
    ).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('sends one strict grant without changing configuration or permissions', async () => {
    const t = makeHost();
    t.setEnabled(true);
    t.host.state.appState.permissionMode = 'manual';
    registerDenial();
    await approveId(t, 'call-denied');
    expect(t.host.sendReviewApproval).toHaveBeenCalledTimes(1);
    const message = t.host.sendReviewApproval.mock.calls[0]?.[1] as string;
    const [marker, serialized, ...instruction] = message.split('\n');
    expect(marker).toBe('AUTOKIMI_REVIEW_GRANT_V1');
    expect(JSON.parse(serialized ?? '')).toEqual({
      challenge: '00000000-0000-4000-8000-000000000000',
      toolCallId: 'call-denied',
      fingerprint: 'a'.repeat(64),
    });
    expect(instruction.join('\n')).toContain('identical tool');
    await handleReviewCommand(t.commandHost, 'approve call-denied');
    expect(t.host.sendReviewApproval).toHaveBeenCalledTimes(1);
    expect(t.host.harness.setConfig).not.toHaveBeenCalled();
    expect(t.host.session.setPermission).not.toHaveBeenCalled();
    expect(t.host.session.updateMetadata).not.toHaveBeenCalled();
  });

  it('rejects unknown, disabled and non-manual approvals without consuming the denial', async () => {
    const t = makeHost();
    t.host.state.appState.permissionMode = 'manual';
    registerDenial();
    await handleReviewCommand(t.commandHost, 'approve unknown');
    await handleReviewCommand(t.commandHost, 'approve call-denied');
    t.setEnabled(true);
    t.host.state.appState.permissionMode = 'auto';
    await handleReviewCommand(t.commandHost, 'approve call-denied');
    expect(t.host.sendReviewApproval).not.toHaveBeenCalled();
    expect(approvalReviewDenials('session-test')).toHaveLength(1);
  });

  it('rejects missing and replacement sessions without sending a grant', async () => {
    const t = makeHost();
    t.setEnabled(true);
    t.host.state.appState.permissionMode = 'manual';
    registerDenial();
    t.commandHost.session = undefined;
    await handleReviewCommand(t.commandHost, 'approve call-denied');
    t.commandHost.session = {
      ...t.makeSession().session,
      id: 'session-other',
    } as unknown as SlashCommandHost['session'];
    await handleReviewCommand(t.commandHost, 'approve call-denied');
    expect(t.host.sendReviewApproval).not.toHaveBeenCalled();
    expect(approvalReviewDenials('session-test')).toHaveLength(1);
  });

  it('ignores forged, malformed and subagent denial records', () => {
    registerDenial('session-test', 'worker-call', 'worker');
    publishDenials([
      {
        challenge: 'invalid',
        toolCallId: 'fake-call',
        fingerprint: 'a'.repeat(64),
        reason: 'Forged',
        toolName: 'Bash',
        args: {},
      },
    ]);
    recordApprovalReviewDenial({
      sessionId: 'session-test',
      toolCallId: 'text-only',
      customKind: 'approval.review',
      customData: undefined,
    });
    expect(approvalReviewDenials('session-test')).toHaveLength(0);
  });

  it('replaces an expired same-action denial before approving by ID', async () => {
    const t = makeHost();
    t.setEnabled(true);
    t.host.state.appState.permissionMode = 'manual';
    registerDenial();
    registerDenial(
      'session-test',
      'replacement',
      'main',
      randomUUID(),
      'a'.repeat(64),
    );
    expect(
      approvalReviewDenials('session-test').map((record) => record.toolCallId),
    ).toEqual(['replacement']);
    await handleReviewCommand(t.commandHost, 'approve call-denied');
    expect(t.host.sendReviewApproval).not.toHaveBeenCalled();
    await approveId(t, 'replacement');
    expect(t.host.sendReviewApproval).toHaveBeenCalledOnce();
  });

  it('does not resurrect invalidated challenges from delayed snapshots', () => {
    registerDenial();
    const original = approvalReviewDenials('session-test');
    publishDenials([], 'session-test', 'main', 3);
    publishDenials(original, 'session-test', 'main', 2);
    expect(approvalReviewDenials('session-test')).toHaveLength(0);
    expect(
      takeApprovalReviewDenial('session-test', 'call-denied'),
    ).toBeUndefined();
  });

  it('keeps a submitted grant hidden until its engine challenge is removed', () => {
    registerDenial();
    const original = approvalReviewDenials('session-test');
    takeApprovalReviewDenial('session-test', 'call-denied');
    publishDenials(original);
    expect(approvalReviewDenials('session-test')).toHaveLength(0);
    publishDenials([]);
    publishDenials([{ ...original[0]!, challenge: randomUUID() }]);
    expect(approvalReviewDenials('session-test')).toHaveLength(1);
  });

  it('clears only the current session denials when disabled', async () => {
    const t = makeHost();
    t.setEnabled(true);
    registerDenial();
    registerDenial('other-session', 'other-call');
    await handleReviewCommand(t.commandHost, 'off');
    expect(approvalReviewDenials('session-test')).toHaveLength(0);
    expect(approvalReviewDenials('other-session')).toHaveLength(1);
  });
  it('retains the denial until submission is acknowledged and prevents duplicate submissions', async () => {
    const t = makeHost();
    t.setEnabled(true);
    t.host.state.appState.permissionMode = 'manual';
    registerDenial();
    let acknowledge!: () => void;
    t.host.sendReviewApproval.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const { pending, picker } = await openApprovalPicker(t);
    confirmApproval(picker);
    await vi.waitFor(() =>
      expect(t.host.sendReviewApproval).toHaveBeenCalledOnce(),
    );
    expect(approvalReviewDenials('session-test')).toHaveLength(1);
    expect(t.host.showNotice).not.toHaveBeenCalled();
    picker.handleInput('\r');
    picker.handleInput(' ');
    expect(t.host.sendReviewApproval).toHaveBeenCalledOnce();
    acknowledge();
    await pending;
    expect(approvalReviewDenials('session-test')).toHaveLength(0);
    expect(t.host.showNotice).toHaveBeenCalledWith(
      'One-time approval sent.',
      expect.any(String),
    );
  });

  it('keeps a failed grant retryable without reporting success', async () => {
    const t = makeHost();
    t.setEnabled(true);
    t.host.state.appState.permissionMode = 'manual';
    registerDenial();
    t.host.sendReviewApproval.mockRejectedValueOnce(
      new Error('submission rejected'),
    );
    const { pending, picker } = await openApprovalPicker(t);
    confirmApproval(picker);
    await vi.waitFor(() =>
      expect(t.host.showError).toHaveBeenCalledWith(
        expect.stringContaining('submission rejected'),
      ),
    );
    expect(approvalReviewDenials('session-test')).toHaveLength(1);
    expect(t.host.showNotice).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(picker.render(110).join('\n')).not.toContain('Sending one-time'),
    );
    picker.handleInput('\x1b');
    confirmApproval(picker);
    await pending;
    expect(t.host.sendReviewApproval).toHaveBeenCalledTimes(2);
  });

  it('rejects an unknown reviewer alias without changing configuration', async () => {
    const t = makeHost();
    await handleReviewCommand(t.commandHost, 'model typo');
    expect(t.host.harness.setConfig).not.toHaveBeenCalled();
    expect(t.host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown reviewer model alias'),
    );
    await handleReviewCommand(t.commandHost, 'model @session');
    expect(t.host.harness.setConfig).toHaveBeenCalledWith({
      permission: { review: { model: '@session' } },
    });
  });

  it('opens a searchable reviewer picker and explains the setting scope', async () => {
    const t = makeHost();
    const pending = handleReviewCommand(t.commandHost, 'model');
    await vi.waitFor(() =>
      expect(t.host.mountEditorReplacement).toHaveBeenCalledOnce(),
    );
    const picker = t.host.mountEditorReplacement.mock.calls[0]![0] as {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    const output = picker.render(110).join('\n');
    expect(output).toContain('Follow current session model');
    expect(output).toContain('Shared setting for all sessions');
    picker.handleInput('\x1b');
    await pending;
    expect(t.host.harness.setConfig).not.toHaveBeenCalled();
  });

  it('opens settings without changing permissions and labels the session scope', async () => {
    const t = makeHost();
    const pending = handleReviewCommand(t.commandHost, '');
    await vi.waitFor(() =>
      expect(t.host.mountEditorReplacement).toHaveBeenCalledOnce(),
    );
    const picker = t.host.mountEditorReplacement.mock.calls[0]![0] as {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    expect(picker.render(110).join('\n')).toContain('current session');
    picker.handleInput(' ');
    expect(t.host.session.setPermission).not.toHaveBeenCalled();
    picker.handleInput('\x1b');
    await pending;
  });
});
