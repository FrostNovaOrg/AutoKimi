import type { SessionSummary } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { sessionRowsForPicker } from '#/tui/utils/session-picker-rows';
import { createApprovalReviewGrantMessage } from '#/tui/commands/review-state';

function summary(input: {
  readonly id: string;
  readonly title?: string;
  readonly lastPrompt?: string;
}): SessionSummary {
  return {
    id: input.id,
    title: input.title,
    lastPrompt: input.lastPrompt,
    workDir: '/tmp/project',
    sessionDir: `/tmp/home/sessions/${input.id}`,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('sessionRowsForPicker', () => {
  it('summarizes approval prompts without changing saved session metadata', () => {
    const lastPrompt = createApprovalReviewGrantMessage({
      challenge: '00000000-0000-4000-8000-000000000000', toolCallId: 'call-denied',
      fingerprint: 'a'.repeat(64), reason: 'Needs approval', toolName: 'Bash', args: { command: 'npm test' },
    });
    const session = summary({ id: 'ses_previous', lastPrompt });
    const rows = sessionRowsForPicker([session], 'ses_current', true);
    expect(rows[0]!.last_prompt).toContain('One-time approval requested');
    expect(rows[0]!.last_prompt).not.toContain('KIMI_REVIEW_GRANT_V1');
    expect(session.lastPrompt).toBe(lastPrompt);
  });

  it('omits the current session when the TUI session has no content', () => {
    const rows = sessionRowsForPicker(
      [
        summary({ id: 'ses_current', title: 'New Session' }),
        summary({ id: 'ses_previous', title: 'New Session' }),
      ],
      'ses_current',
      false,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_previous']);
  });

  it('keeps the current session when the TUI session has content', () => {
    const rows = sessionRowsForPicker(
      [
        summary({
          id: 'ses_current',
          title: 'Implement feature',
          lastPrompt: 'Implement feature',
        }),
      ],
      'ses_current',
      true,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_current']);
  });

  it('does not filter empty historical sessions', () => {
    const rows = sessionRowsForPicker(
      [
        summary({ id: 'ses_current', title: 'New Session' }),
        summary({ id: 'ses_previous_empty', title: 'New Session' }),
      ],
      'ses_current',
      false,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_previous_empty']);
  });
});
