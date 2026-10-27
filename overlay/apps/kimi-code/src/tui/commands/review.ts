import type { SlashCommandHost } from './dispatch';
import { setExperimentalFeatures } from './experimental-flags';
import {
  notePermissionStateChanged,
  permissionStateRevision,
} from './permission-state';
import {
  approvalReviewDenials,
  approvalReviewMetadata,
  clearApprovalReviewDenials,
  createApprovalReviewGrantMessage,
  effectiveApprovalReview,
  takeApprovalReviewDenial,
  type ApprovalReviewDenial,
} from './review-state';
import { formatErrorMessage } from '../utils/event-payload';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { ReviewApprovalComponent } from '../components/dialogs/review-approval';

const pendingApprovals = new Set<string>();

async function submitInteractiveApproval(
  host: SlashCommandHost,
  session: NonNullable<SlashCommandHost['session']>,
  selected: ApprovalReviewDenial,
  cancelled: () => boolean,
): Promise<boolean> {
  const key = `${session.id}:${selected.challenge}`;
  if (pendingApprovals.has(key)) return false;
  pendingApprovals.add(key);
  try {
    const features = await host.harness.getExperimentalFeatures();
    if (cancelled()) return false;
    setExperimentalFeatures(features);
    const feature = features.find((entry) => entry.id === 'approval_review');
    if (
      host.session !== session ||
      host.state.appState.sessionId !== session.id ||
      !effectiveApprovalReview(session, feature) ||
      host.state.appState.permissionMode !== 'manual'
    ) {
      host.showError('The selected auto-review denial is no longer active.');
      return false;
    }
    const denial = approvalReviewDenials(session.id).find(
      (record) =>
        record.toolCallId === selected.toolCallId &&
        record.challenge === selected.challenge,
    );
    if (denial === undefined) {
      host.showError(`No eligible auto-review denial: ${selected.toolCallId}`);
      return false;
    }
    await host.sendReviewApproval(
      session,
      createApprovalReviewGrantMessage(denial),
    );
    takeApprovalReviewDenial(session.id, denial.toolCallId, denial.challenge);
    if (!cancelled())
      host.showNotice(
        'One-time approval sent.',
        'The identical action must be proposed again and pass auto-review. No permission rule was changed.',
      );
    return true;
  } catch (error) {
    if (!cancelled())
      host.showError(
        `Failed to submit one-time approval: ${formatErrorMessage(error)}`,
      );
    return false;
  } finally {
    pendingApprovals.delete(key);
  }
}

function promptInteractiveApproval(
  host: SlashCommandHost,
  session: NonNullable<SlashCommandHost['session']>,
  records: readonly ApprovalReviewDenial[],
): Promise<void> {
  return new Promise((resolve) => {
    let cancelled = false;
    const panel = new ReviewApprovalComponent({
      records,
      workDir: session.workDir ?? host.state.appState.workDir,
      rows: () => host.state.terminal.rows,
      approve: (record) =>
        submitInteractiveApproval(host, session, record, () => cancelled),
      cancel: () => host.restoreEditor(),
      done: () => host.restoreEditor(),
      render: () => host.state.ui.requestRender(),
    });
    host.mountEditorReplacement(panel, () => {
      cancelled = true;
      panel.dispose();
      resolve();
    });
  });
}

function reviewChoice(
  host: SlashCommandHost,
  options: ConstructorParameters<typeof ChoicePickerComponent>[0],
): Promise<void> {
  return new Promise((resolve) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        ...options,
        spaceSelect: false,
        onSelect: (value) => {
          host.restoreEditor();
          options.onSelect(value);
        },
        onCancel: () => host.restoreEditor(),
      }),
      resolve,
    );
  });
}

export async function handleReviewCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const input = args.trim();
  const features = await host.harness.getExperimentalFeatures();
  setExperimentalFeatures(features);
  const feature = features.find((entry) => entry.id === 'approval_review');
  if (feature === undefined) {
    host.showError(
      'This runtime does not support model approval review. Start the matching custom CLI and runtime.',
    );
    return;
  }
  if (input === '') {
    const enabled = effectiveApprovalReview(host.session, feature);
    const scope =
      host.session === undefined ? 'global default' : 'current session';
    await reviewChoice(host, {
      title: 'Auto-review settings',
      notice: `Review switch: ${scope}. Reviewer model: shared configuration.`,
      noticeTone: 'warning',
      options: [
        { value: 'status', label: `Status: ${enabled ? 'ON' : 'OFF'}` },
        { value: 'on', label: 'Enable review in Always Ask mode' },
        { value: 'off', label: 'Disable review' },
        { value: 'model', label: 'Reviewer model' },
        { value: 'approve', label: 'Review denied actions' },
      ],
      onSelect: (value) => {
        void handleReviewCommand(host, value).catch((error) =>
          host.showError(formatErrorMessage(error)),
        );
      },
      onCancel: () => {},
    });
    return;
  }
  if (input === 'status') {
    const config = await host.harness.getConfig();
    const enabled = effectiveApprovalReview(host.session, feature);
    host.setAppState({ approvalReviewEnabled: enabled });
    host.showNotice(
      `Auto-review: ${enabled ? 'ON' : 'OFF'}; reviewer: ${config.permission?.review?.model === '@session' ? 'current session model' : (config.permission?.review?.model ?? 'current session model')}.`,
      !enabled
        ? 'Disabled: tool approvals follow your selected permission mode.'
        : host.state.appState.permissionMode === 'manual'
          ? 'Pending tool approvals are reviewed; uncertain or failed reviews deny the action without a permission prompt.'
          : 'Paused: select Always Ask mode to review pending approvals.',
    );
    return;
  }
  if (
    input === 'denials' ||
    input === 'approve' ||
    input === 'interactive-approve' ||
    input.startsWith('approve ')
  ) {
    const session = host.session;
    if (session === undefined || host.state.appState.sessionId !== session.id) {
      host.showError('Auto-review denials require the current active session.');
      return;
    }
    if (input === 'denials') {
      const records = approvalReviewDenials(session.id);
      host.showNotice(
        `Auto-review denials: ${records.length}`,
        records.length === 0
          ? 'No eligible model denials.'
          : records
              .map(
                (record) =>
                  `${record.toolCallId} ${record.toolName}: ${record.reason}`,
              )
              .join('\n'),
      );
      return;
    }
    if (
      !effectiveApprovalReview(session, feature) ||
      host.state.appState.permissionMode !== 'manual'
    ) {
      host.showError(
        'One-time approval requires auto-review active in Always Ask mode.',
      );
      return;
    }
    if (input === 'approve' || input === 'interactive-approve') {
      const records = approvalReviewDenials(session.id);
      if (records.length === 0) {
        host.showNotice('Auto-review denials: 0', 'No eligible model denials.');
        return;
      }
      await promptInteractiveApproval(host, session, records);
      return;
    }
    const toolCallId = input.slice(8).trim();
    if (toolCallId.length === 0 || /\s/.test(toolCallId)) {
      host.showError('Usage: /auto-review approve [toolCallId]');
      return;
    }
    const denial = approvalReviewDenials(session.id).find(
      (record) => record.toolCallId === toolCallId,
    );
    if (denial === undefined) {
      host.showError(`No eligible auto-review denial: ${toolCallId}`);
      return;
    }
    await promptInteractiveApproval(host, session, [denial]);
    return;
  }
  if (input === 'model' || input.startsWith('model ')) {
    const config = await host.harness.getConfig();
    const models = config.models ?? {};
    if (input === 'model') {
      await reviewChoice(host, {
        title: 'Select reviewer model',
        notice:
          'Shared setting for all sessions. @session follows each session model.',
        currentValue: config.permission?.review?.model ?? '@session',
        searchable: true,
        options: [
          { value: '@session', label: 'Follow current session model' },
          ...Object.keys(models)
            .filter((alias) => alias !== '@session')
            .map((alias) => ({ value: alias, label: alias })),
        ],
        onSelect: (value) => {
          void handleReviewCommand(host, `model ${value}`).catch((error) =>
            host.showError(formatErrorMessage(error)),
          );
        },
        onCancel: () => {},
      });
      return;
    }
    const model = input.slice(6).trim();
    if (model !== '@session' && !Object.hasOwn(models, model)) {
      host.showError(
        `Unknown reviewer model alias: ${model}. Use /auto-review model to select a configured model.`,
      );
      return;
    }
    await host.harness.setConfig({ permission: { review: { model } } });
    host.showNotice(
      `Approval reviewer model: ${model === '@session' ? 'current session model' : model}`,
      'Scope: shared configuration for all sessions.',
    );
    return;
  }
  if (input !== 'on' && input !== 'off') {
    host.showError(
      'Usage: /auto-review [on|off|status|denials|approve [toolCallId]|model <configured-model-alias>]',
    );
    return;
  }
  if (feature.source === 'env' || feature.source === 'master-env') {
    host.showError(
      `Auto-review is controlled by ${feature.source === 'env' ? feature.env : 'KIMI_CODE_EXPERIMENTAL_FLAG'}. Remove that environment override before changing it here.`,
    );
    return;
  }
  try {
    const session = host.session;
    if (input === 'off') clearApprovalReviewDenials(session?.id);
    if (input === 'on') {
      const appState = host.state.appState;
      const revision = permissionStateRevision();
      await session?.setPermission('manual');
      if (session === undefined) {
        await host.harness.setConfig({
          defaultPermissionMode: 'manual',
          experimental: { approval_review: true },
        });
      } else {
        await session.updateMetadata(approvalReviewMetadata(true));
      }
      if (
        host.session === session &&
        host.state.appState === appState &&
        permissionStateRevision() === revision
      ) {
        host.setAppState({ permissionMode: 'manual' });
        notePermissionStateChanged();
      }
    } else if (session === undefined) {
      await host.harness.setConfig({
        experimental: { approval_review: false },
      });
    } else {
      await session.updateMetadata(approvalReviewMetadata(false));
    }
    const latestFeatures = await host.harness.getExperimentalFeatures();
    setExperimentalFeatures(latestFeatures);
    const latestFeature =
      latestFeatures.find((entry) => entry.id === 'approval_review') ?? feature;
    const enabled = effectiveApprovalReview(host.session, latestFeature);
    host.setAppState({ approvalReviewEnabled: enabled });
    host.refreshSlashCommandAutocomplete();
    host.showNotice(
      `Auto-review: ${enabled ? 'ON' : 'OFF'}`,
      `Scope: ${host.session === undefined ? 'global default' : 'current session'}. ` +
        (enabled
          ? host.state.appState.permissionMode === 'manual'
            ? 'Model checks pending tool approvals. Uncertain or failed reviews deny the action without a permission prompt.'
            : 'Auto-review is enabled but paused in the current permission mode. Select Always Ask to review pending approvals.'
          : 'Tool approvals return to your selected permission mode.'),
    );
  } catch (error) {
    host.showError(
      `Failed to change auto-review: ${formatErrorMessage(error)}`,
    );
  }
}
