import type {
  ExperimentalFeatureState,
  JsonObject,
} from '@moonshot-ai/kimi-code-sdk';
import {
  APPROVAL_REVIEW_DENIAL_KIND,
  APPROVAL_REVIEW_DENIAL_LIMIT,
  APPROVAL_REVIEW_GRANT_INSTRUCTION,
  APPROVAL_REVIEW_GRANT_MARKER,
} from '../constant/approval-review';

interface ReviewSession {
  getResumeState():
    | { sessionMetadata: { custom?: Record<string, unknown> } }
    | undefined;
  summary?: { metadata?: Record<string, unknown> };
}

export function approvalReviewMetadata(enabled: boolean): JsonObject {
  return { autokimi: { approvalReview: enabled } };
}

export function sessionApprovalReviewOverride(
  session: ReviewSession | undefined,
): boolean | undefined {
  const custom =
    session?.getResumeState()?.sessionMetadata.custom ??
    session?.summary?.metadata;
  const container = custom?.['autokimi'];
  if (
    typeof container !== 'object' ||
    container === null ||
    Array.isArray(container)
  )
    return undefined;
  const enabled = (container as Record<string, unknown>)['approvalReview'];
  return typeof enabled === 'boolean' ? enabled : undefined;
}

export function effectiveApprovalReview(
  session: ReviewSession | undefined,
  feature: ExperimentalFeatureState | undefined,
): boolean {
  if (feature === undefined) return false;
  if (feature.source === 'env' || feature.source === 'master-env')
    return feature.enabled;
  return sessionApprovalReviewOverride(session) ?? feature.enabled;
}

export interface ApprovalReviewDenial {
  challenge: string;
  toolCallId: string;
  fingerprint: string;
  reason: string;
  toolName: string;
  args: Record<string, unknown>;
}

interface DenialToolCall {
  name: string;
  args: Record<string, unknown>;
}

const denialRecords = new Map<string, Map<string, ApprovalReviewDenial>>();

export function recordApprovalReviewDenial(input: {
  sessionId: string;
  toolCallId: string;
  customKind: string | undefined;
  customData: unknown;
  toolCall: DenialToolCall | undefined;
}): void {
  if (
    input.sessionId.length === 0 ||
    input.customKind !== 'approval.review' ||
    typeof input.customData !== 'object' ||
    input.customData === null ||
    Array.isArray(input.customData)
  )
    return;
  const data = input.customData as Record<string, unknown>;
  const challenge = data['challenge'];
  const toolCallId = data['toolCallId'];
  const fingerprint = data['fingerprint'];
  const reason = data['reason'];
  const toolName = input.toolCall?.name ?? data['toolName'];
  const args = input.toolCall?.args ?? data['args'];
  if (
    data['kind'] !== APPROVAL_REVIEW_DENIAL_KIND ||
    data['version'] !== 1 ||
    data['agentId'] !== 'main' ||
    toolCallId !== input.toolCallId ||
    typeof challenge !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      challenge,
    ) ||
    typeof toolCallId !== 'string' ||
    typeof fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(fingerprint) ||
    typeof reason !== 'string' ||
    reason.length === 0 ||
    typeof toolName !== 'string' ||
    toolName.length === 0 ||
    typeof args !== 'object' ||
    args === null ||
    Array.isArray(args)
  )
    return;
  const records = denialRecords.get(input.sessionId) ?? new Map();
  records.delete(input.toolCallId);
  records.set(input.toolCallId, {
    challenge,
    toolCallId: input.toolCallId,
    fingerprint,
    reason,
    toolName,
    args: args as Record<string, unknown>,
  });
  while (records.size > APPROVAL_REVIEW_DENIAL_LIMIT) {
    const oldest = records.keys().next().value;
    if (oldest !== undefined) records.delete(oldest);
  }
  denialRecords.set(input.sessionId, records);
}

export function approvalReviewDenials(
  sessionId: string,
): readonly ApprovalReviewDenial[] {
  return [...(denialRecords.get(sessionId)?.values() ?? [])];
}

export function takeApprovalReviewDenial(
  sessionId: string,
  toolCallId: string,
  challenge?: string,
): ApprovalReviewDenial | undefined {
  const records = denialRecords.get(sessionId);
  const record = records?.get(toolCallId);
  if (
    record === undefined ||
    (challenge !== undefined && record.challenge !== challenge)
  )
    return undefined;
  records?.delete(toolCallId);
  return record;
}

export function clearApprovalReviewDenials(sessionId?: string): void {
  if (sessionId === undefined) denialRecords.clear();
  else denialRecords.delete(sessionId);
}

export function createApprovalReviewGrantMessage(
  denial: ApprovalReviewDenial,
): string {
  return `${APPROVAL_REVIEW_GRANT_MARKER}\n${JSON.stringify({ challenge: denial.challenge, toolCallId: denial.toolCallId, fingerprint: denial.fingerprint })}\n${APPROVAL_REVIEW_GRANT_INSTRUCTION}`;
}
