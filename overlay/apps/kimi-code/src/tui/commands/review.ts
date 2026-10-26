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

async function submitInteractiveApproval(
  host: SlashCommandHost,
  session: NonNullable<SlashCommandHost['session']>,
  selected: ApprovalReviewDenial,
  cancelled: () => boolean,
): Promise<boolean> {
  const features = await host.harness.getExperimentalFeatures().catch((error) => {
    if (!cancelled())
      host.showError(`Failed to refresh review state: ${formatErrorMessage(error)}`);
    return undefined;
  });
  if (features === undefined || cancelled()) return false;
  setExperimentalFeatures(features);
  const feature = features.find((entry) => entry.id === 'approval_review');
  if (
    host.session !== session ||
    host.state.appState.sessionId !== session.id ||
    feature === undefined ||
    !effectiveApprovalReview(host.session, feature) ||
    host.state.appState.permissionMode !== 'manual'
  ) {
    if (!cancelled())
      host.showError('The selected auto-review denial is no longer active.');
    return false;
  }
  const denial = takeApprovalReviewDenial(
    session.id,
    selected.toolCallId,
    selected.challenge,
  );
  if (denial === undefined) {
    if (!cancelled())
      host.showError(`No eligible auto-review denial: ${selected.toolCallId}`);
    return false;
  }
  if (cancelled()) return false;
  try {
    host.sendNormalUserInput(createApprovalReviewGrantMessage(denial));
  } catch (error) {
    if (!cancelled())
      host.showError(
        `Failed to submit one-time approval: ${formatErrorMessage(error)}`,
      );
    return false;
  }
  host.showNotice(
    'One-time approval sent.',
    'The identical action must be proposed again and pass auto-review. No permission rule was changed.',
  );
  return true;
}

function promptInteractiveApproval(
  host: SlashCommandHost,
  session: NonNullable<SlashCommandHost['session']>,
  records: readonly ApprovalReviewDenial[],
): Promise<void> {
  return new Promise((resolve) => {
    const defaultHint = '↑↓ navigate · Enter approve once · Esc cancel';
    let hint = defaultHint;
    let phase: 'selecting' | 'approving' | 'approved' = 'selecting';
    let cancelled = false;
    const options: Array<{
      value: string;
      label: string;
      description: string;
      tone?: 'danger';
      descriptionTone?: 'success';
    }> = records.map((record) => ({
      value: record.toolCallId,
      label: `✗ ${record.toolName}: ${record.reason}`,
      description: JSON.stringify(record.args),
      tone: 'danger',
    }));
    const picker = new ChoicePickerComponent({
      title: 'Approve one denied action',
      get hint() {
        return hint;
      },
      notice:
        'One identical retry must pass auto-review again. No permission rule will be changed.',
      options,
      initialValue: records.at(-1)?.toolCallId,
      onSelect: (toolCallId) => {
        if (phase === 'approved') {
          host.restoreEditor();
          resolve();
          return;
        }
        if (phase === 'approving') return;
        const record = records.find((item) => item.toolCallId === toolCallId);
        const option = options.find((item) => item.value === toolCallId);
        if (record === undefined || option === undefined) return;
        phase = 'approving';
        hint = 'Approving…';
        host.state.ui.requestRender();
        void submitInteractiveApproval(host, session, record, () => cancelled).then(
          (approved) => {
            if (cancelled) return;
            if (!approved) {
              phase = 'selecting';
              hint = defaultHint;
            } else {
              phase = 'approved';
              option.label = `✓ ${record.toolName}: ${record.reason}`;
              option.tone = undefined;
              option.description = 'Approved once; no permission rule changed.';
              option.descriptionTone = 'success';
              hint = 'Approval sent · Enter confirm · Esc cancel';
            }
            host.state.ui.requestRender();
          },
        );
      },
      onCancel: () => {
        cancelled = true;
        host.restoreEditor();
        resolve();
      },
    });
    host.mountEditorReplacement(picker);
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
  if (input === '' || input === 'status') {
    const config = await host.harness.getConfig();
    const enabled = effectiveApprovalReview(host.session, feature);
    host.setAppState({ approvalReviewEnabled: enabled });
    host.showNotice(
      `Auto-review: ${enabled ? 'ON' : 'OFF'}; reviewer: ${config.permission?.review?.model ?? 'current session model'}.`,
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
    if (
      session === undefined ||
      host.state.appState.sessionId !== session.id
    ) {
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
        host.showNotice(
          'Auto-review denials: 0',
          'No eligible model denials.',
        );
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
    const denial = takeApprovalReviewDenial(session.id, toolCallId);
    if (denial === undefined) {
      host.showError(`No eligible auto-review denial: ${toolCallId}`);
      return;
    }
    try {
      host.sendNormalUserInput(createApprovalReviewGrantMessage(denial));
    } catch (error) {
      host.showError(
        `Failed to submit one-time approval: ${formatErrorMessage(error)}`,
      );
      return;
    }
    host.showNotice(
      'One-time approval sent.',
      'The identical action must be proposed again and pass auto-review. No permission rule was changed.',
    );
    return;
  }
  if (input.startsWith('model ')) {
    const model = input.slice(6).trim();
    if (model.length === 0 || /\s/.test(model)) {
      host.showError('Usage: /auto-review model <configured-model-alias>');
      return;
    }
    await host.harness.setConfig({
      permission: { review: { model } },
    });
    host.showNotice(`Approval reviewer model: ${model}`);
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
      enabled
        ? host.state.appState.permissionMode === 'manual'
          ? 'Model checks pending tool approvals. Uncertain or failed reviews deny the action without a permission prompt.'
          : 'Auto-review is enabled but paused in the current permission mode. Select Always Ask to review pending approvals.'
        : 'Tool approvals return to your selected permission mode.',
    );
  } catch (error) {
    host.showError(
      `Failed to change auto-review: ${formatErrorMessage(error)}`,
    );
  }
}
