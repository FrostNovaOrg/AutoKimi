import { createDecorator } from '#/_base/di/instantiation';
import type { PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

export type ApprovalReviewResult =
  | Extract<PermissionPolicyResult, { kind: 'approve' }>
  | {
      readonly kind: 'deny';
      readonly message: string;
      readonly stopTurn?: boolean;
    };

export interface IAgentApprovalReviewService {
  readonly _serviceBrand: undefined;
  isEnabled(): boolean;
  review(
    context: ResolvedToolExecutionHookContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    origin: string,
  ): Promise<ApprovalReviewResult>;
}

export const IAgentApprovalReviewService =
  createDecorator<IAgentApprovalReviewService>('agentApprovalReviewService');
