import type { SessionSummary } from '@moonshot-ai/kimi-code-sdk';

import type { SessionRow } from '#/tui/components/dialogs/session-picker';
import { reviewApprovalMessageText } from '#/tui/utils/review-approval-message';

export function sessionRowsForPicker(
  sessions: readonly SessionSummary[],
  currentSessionId: string,
  currentSessionHasContent: boolean,
): SessionRow[] {
  return sessions
    .filter(
      (session) => currentSessionHasContent || session.id !== currentSessionId,
    )
    .map((session) => ({
      id: session.id,
      title: session.title ?? null,
      last_prompt:
        typeof session.lastPrompt === 'string'
          ? reviewApprovalMessageText(session.lastPrompt)
          : null,
      work_dir: session.workDir,
      updated_at: session.updatedAt ?? session.createdAt ?? 0,
      metadata: session.metadata,
    }));
}
