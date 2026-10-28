import {
  APPROVAL_REVIEW_GRANT_INSTRUCTION,
  APPROVAL_REVIEW_GRANT_MARKER,
} from '#/tui/constant/approval-review';

export function reviewApprovalMessageText(text: string): string {
  if (!text.startsWith(APPROVAL_REVIEW_GRANT_MARKER + '\n')) return text;
  const lines = text.split('\n');
  if (lines.length !== 3 || lines[2] !== APPROVAL_REVIEW_GRANT_INSTRUCTION)
    return text;
  try {
    const value: unknown = JSON.parse(lines[1]!);
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return text;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      typeof record['challenge'] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        record['challenge'],
      ) ||
      typeof record['fingerprint'] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record['fingerprint']) ||
      typeof record['toolCallId'] !== 'string' ||
      record['toolCallId'].length === 0
    )
      return text;
    return 'One-time approval requested. The identical action must pass Auto Review again.';
  } catch {
    return text;
  }
}
