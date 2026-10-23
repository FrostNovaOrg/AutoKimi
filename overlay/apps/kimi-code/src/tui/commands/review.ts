import type { SlashCommandHost } from './dispatch';
import { setExperimentalFeatures } from './experimental-flags';
import { formatErrorMessage } from '../utils/event-payload';

export async function handleReviewCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const input = args.trim();
  const features = await host.harness.getExperimentalFeatures();
  const feature = features.find((entry) => entry.id === 'approval_review');
  if (feature === undefined) {
    host.showError(
      'This runtime does not support model approval review. Start the matching custom CLI and runtime.',
    );
    return;
  }
  if (input === '' || input === 'status') {
    const config = await host.harness.getConfig();
    host.showNotice(
      `Auto-review: ${feature.enabled ? 'ON' : 'OFF'}; reviewer: ${config.permission?.review?.model ?? 'current session model'}.`,
      !feature.enabled
        ? 'Disabled: tool approvals follow your selected permission mode.'
        : host.state.appState.permissionMode === 'manual'
          ? 'Pending tool approvals are reviewed; uncertain or failed reviews deny the action without a permission prompt.'
          : 'Paused: select Always Ask mode to review pending approvals.',
    );
    return;
  }
  if (input.startsWith('model ')) {
    const model = input.slice(6).trim();
    if (model.length === 0 || /\s/.test(model)) {
      host.showError('Usage: /auto-review model <configured-model-alias>');
      return;
    }
    const config = await host.harness.getConfig();
    await host.harness.setConfig({
      permission: {
        review: {
          timeoutMs: 30000,
          maxContextChars: 24000,
          twoStage: true,
          ...config.permission?.review,
          model,
        },
      },
    });
    host.showNotice(`Approval reviewer model: ${model}`);
    return;
  }
  if (input !== 'on' && input !== 'off') {
    host.showError(
      'Usage: /auto-review [on|off|status|model <configured-model-alias>]',
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
    if (input === 'on') {
      await host.session?.setPermission('manual');
      await host.harness.setConfig({
        defaultPermissionMode: 'manual',
        experimental: { approval_review: true },
      });
      host.setAppState({ permissionMode: 'manual' });
    } else {
      await host.harness.setConfig({
        experimental: { approval_review: false },
      });
    }
    setExperimentalFeatures(await host.harness.getExperimentalFeatures());
    host.refreshSlashCommandAutocomplete();
    host.showNotice(
      `Auto-review: ${input.toUpperCase()}`,
      input === 'on'
        ? 'Model checks pending tool approvals. Uncertain or failed reviews deny the action without a permission prompt.'
        : 'Tool approvals return to your selected permission mode.',
    );
  } catch (error) {
    host.showError(
      `Failed to change auto-review: ${formatErrorMessage(error)}`,
    );
  }
}
