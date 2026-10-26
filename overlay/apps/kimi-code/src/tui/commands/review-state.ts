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
    { sessionMetadata: { custom?: Record<string, unknown> } } | undefined;
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

interface DenialState {
  sequence: number;
  records: Map<string, ApprovalReviewDenial>;
  consumed: Set<string>;
}

const denialRecords = new Map<string, DenialState>();

function parseDenial(value: unknown): ApprovalReviewDenial | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const data = value as Record<string, unknown>;
  const { challenge, toolCallId, fingerprint, reason, toolName, args } = data;
  if (
    typeof challenge !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      challenge,
    ) ||
    typeof toolCallId !== 'string' ||
    toolCallId.length === 0 ||
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
    return undefined;
  return {
    challenge,
    toolCallId,
    fingerprint,
    reason,
    toolName,
    args: args as Record<string, unknown>,
  };
}

export function recordApprovalReviewDenial(input: {
  sessionId: string;
  toolCallId: string;
  customKind: string | undefined;
  customData: unknown;
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
  const sequence = data['sequence'];
  const values = data['denials'];
  if (
    data['kind'] !== APPROVAL_REVIEW_DENIAL_KIND ||
    data['version'] !== 1 ||
    data['agentId'] !== 'main' ||
    data['toolCallId'] !== input.toolCallId ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !Array.isArray(values) ||
    values.length > APPROVAL_REVIEW_DENIAL_LIMIT
  )
    return;
  const state = denialRecords.get(input.sessionId);
  if (state !== undefined && sequence <= state.sequence) return;
  const records = values.map(parseDenial);
  if (records.some((record) => record === undefined)) return;
  const denials = records as ApprovalReviewDenial[];
  if (
    new Set(denials.map((record) => record.toolCallId)).size !==
      denials.length ||
    new Set(denials.map((record) => record.fingerprint)).size !== denials.length
  )
    return;
  const active = new Set(denials.map((record) => record.challenge));
  const consumed = new Set(
    [...(state?.consumed ?? [])].filter((id) => active.has(id)),
  );
  denialRecords.set(input.sessionId, {
    sequence,
    consumed,
    records: new Map(
      denials
        .filter((record) => !consumed.has(record.challenge))
        .map((record) => [record.toolCallId, record]),
    ),
  });
}

export function approvalReviewDenials(
  sessionId: string,
): readonly ApprovalReviewDenial[] {
  return [...(denialRecords.get(sessionId)?.records.values() ?? [])];
}

export function takeApprovalReviewDenial(
  sessionId: string,
  toolCallId: string,
  challenge?: string,
): ApprovalReviewDenial | undefined {
  const state = denialRecords.get(sessionId);
  const record = state?.records.get(toolCallId);
  if (
    record === undefined ||
    (challenge !== undefined && record.challenge !== challenge)
  )
    return undefined;
  state?.records.delete(toolCallId);
  state?.consumed.add(record.challenge);
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
