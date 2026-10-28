import { IHeadlessRun } from '#/app/headlessRun/control';
/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { randomUUID } from 'node:crypto';

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { abortable, isUserCancellation } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import {
  IAgentApprovalReviewService,
  type ApprovalReviewResult,
} from '#/agent/approvalReview/approvalReview';
import '#/agent/approvalReview/approvalReviewService';
import type {
  ApprovalResponse,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { AgentEvent2 } from '#/app/event/event2';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  INTERACTION_TAG_TURN_ID,
  type InteractionTags,
} from '#/human/interaction/interaction';
import { interactions } from '#/human/interaction/facade';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { IAgentToolApprovalService } from './toolApproval';

export interface PermissionApprovalRequestedPayload {
  readonly id?: string;
  readonly sessionId?: string;
  readonly agentId: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
  readonly toolInput: unknown;
  readonly cwd?: string;
  readonly approvalRule?: string;
}

export class PermissionApprovalRequested extends AgentEvent2<PermissionApprovalRequestedPayload> {
  static override readonly type = 'permission.approval.requested';
  static override readonly observable = true;
}
export interface PermissionApprovalRequested
  extends PermissionApprovalRequestedPayload {}

export interface PermissionApprovalResolvedPayload
  extends PermissionApprovalRequestedPayload {
  readonly decision: 'approved' | 'rejected' | 'cancelled' | 'error';
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
  readonly error?: string;
}

export class PermissionApprovalResolved extends AgentEvent2<PermissionApprovalResolvedPayload> {
  static override readonly type = 'permission.approval.resolved';
  static override readonly observable = true;
}
export interface PermissionApprovalResolved
  extends PermissionApprovalResolvedPayload {}

export class AgentToolApprovalService
  extends Service
  implements IAgentToolApprovalService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentPermissionModeService
    private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionRulesService
    private readonly rulesService: IAgentPermissionRulesService,
    @ISessionContext private readonly session: ISessionContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentApprovalReviewService
    private readonly reviewer: IAgentApprovalReviewService,
    @IHeadlessRun private readonly headless?: IHeadlessRun,
  ) {
    super();
  }

  async resolvePermissionResolution(
    result: PermissionPolicyResolution,
    context: ResolvedToolExecutionHookContext,
    origin: string,
  ): Promise<BeforeExecuteDecision | undefined> {
    switch (result.kind) {
      case 'approve':
        return result.executionMetadata === undefined
          ? undefined
          : { executionMetadata: result.executionMetadata };
      case 'deny':
        return {
          veto: denyToolExecution(
            this.formatDenyMessage(
              result.message ??
                `Tool "${context.toolCall.name}" was denied by permission policy.`,
            ),
          ),
        };
      case 'ask':
        return this.requestToolApproval(context, result, origin);
      case 'result':
        return { veto: result.result };
    }
  }

  async requestToolApproval(
    context: ResolvedToolExecutionHookContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    origin: string,
  ): Promise<BeforeExecuteDecision | undefined> {
    if (this.headless?.active && !this.reviewer.isEnabled()) {
      this.headless?.stop('review_disabled');
      this.headless?.check();
    }
    if (this.modeService.mode === 'review' && !this.reviewer.isEnabled()) {
      return { veto: { output: 'Auto Review is unavailable; this action was denied.', isError: true, stopTurn: true } };
    }
    const interactiveReview = !this.headless?.active &&
      result.resolveApproval !== undefined &&
      ((origin === 'exit-plan-mode-review-ask' &&
        context.toolCall.name === 'ExitPlanMode' &&
        context.execution.display?.kind === 'plan_review') ||
        (origin === 'goal-start-review-ask' &&
          context.toolCall.name === 'CreateGoal' &&
          context.execution.display?.kind === 'goal_start'));
    if (this.reviewer.isEnabled() && !interactiveReview) {
      let reviewed: ApprovalReviewResult;
      try {
        reviewed = await this.reviewer.review(context, result, origin);
        if (
          (reviewed?.kind !== 'approve' && reviewed?.kind !== 'deny') ||
          (reviewed.kind === 'deny' &&
            (typeof reviewed.message !== 'string' ||
              reviewed.message.trim().length === 0))
        )
          throw new Error('Invalid automatic review resolution');
      } catch (error) {
        context.signal.throwIfAborted();
        if (isUserCancellation(error)) throw error;
        return {
          veto: {
            ...denyToolExecution(
              this.formatDenyMessage(
                'Auto-review failed to produce a valid permission decision; this action was denied and the turn stopped. Do not retry or request a manual permission override.',
              ),
            ),
            stopTurn: true,
          },
        };
      }
      context.signal.throwIfAborted();
      if (reviewed.kind === 'deny')
        return {
          veto: {
            ...denyToolExecution(this.formatDenyMessage(reviewed.message)),
            stopTurn: reviewed.stopTurn,
          },
        };
      return this.resolvePermissionResolution(
        reviewed,
        context,
        'model-approval-review',
      );
    }
    const name = context.toolCall.name;
    if (this.bootstrap.args.nonInteractive === true) {
      return this.resolvePermissionResolution(
        (this.modeService.mode === 'review' && interactiveReview ? undefined : result.resolveNonInteractive?.()) ?? {
          kind: 'deny',
          message: `Tool "${name}" needs approval, but nobody can approve it in a non-interactive run.`,
        },
        context,
        origin,
      );
    }
    const action = context.execution.description ?? `Approve ${name}`;
    const display =
      context.execution.display ??
      ({
        kind: 'generic',
        summary: action,
        detail: context.args,
      } as ToolInputDisplay);
    const approvalRequest = {
      id: `approval_${randomUUID()}`,
      sessionId: this.session.sessionId,
      agentId: this.scopeContext.agentId,
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: name,
      action,
      display,
    };
    const approvalContext = {
      ...approvalRequest,
      toolInput: context.args,
      cwd: this.session.cwd,
      approvalRule: context.execution.approvalRule,
    } satisfies PermissionApprovalRequestedPayload;
    const startedAt = Date.now();

    const tags: InteractionTags = {
      [INTERACTION_TAG_AGENT_ID]: this.scopeContext.agentId,
      [INTERACTION_TAG_SESSION_ID]: this.session.sessionId,
      [INTERACTION_TAG_TURN_ID]: context.turnId,
      [INTERACTION_TAG_TOOL_CALL_ID]: context.toolCall.id,
    };
    let response: ApprovalResponse;
    void this.dispatcher.dispatch(
      new PermissionApprovalRequested(approvalContext),
    );
    try {
      response = await abortable(
        interactions.request<typeof approvalContext, ApprovalResponse>({
          id: approvalRequest.id,
          kind: 'approval',
          payload: approvalContext,
          tags,
        }),
        context.signal,
      );
      if (response.decision === 'approved' && response.scope !== 'session')
        this.reviewer.consumeApprovedInteraction(approvalRequest.id);
      context.signal.throwIfAborted();
    } catch (error) {
      if (isUserCancellation(error)) throw error;
      this.telemetry.track2('permission_approval_result', {
        turn_id: context.turnId,
        tool_call_id: context.toolCall.id,
        policy_name: origin,
        tool_name: name,
        permission_mode: this.modeService.mode,
        result: 'error',
        approval_surface: display.kind,
        duration_ms: Date.now() - startedAt,
        session_cache_written: false,
        has_feedback: false,
        trace_id: context.trace?.traceId,
      });
      void this.dispatcher.dispatch(
        new PermissionApprovalResolved({
          ...approvalContext,
          decision: 'error',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      const resolved = result.resolveError?.(error);
      if (resolved !== undefined) {
        return this.resolvePermissionResolution(resolved, context, origin);
      }
      throw error;
    }

    const sessionApprovalRule =
      response.decision === 'approved' && response.scope === 'session'
        ? context.execution.approvalRule
        : undefined;
    void this.dispatcher.dispatch(
      new PermissionApprovalResolved({
        ...approvalContext,
        ...response,
      }),
    );
    this.rulesService.recordApprovalResult({
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: name,
      action,
      sessionApprovalRule,
      result: response,
    });
    this.telemetry.track2('permission_approval_result', {
      turn_id: context.turnId,
      tool_call_id: context.toolCall.id,
      policy_name: origin,
      tool_name: name,
      permission_mode: this.modeService.mode,
      result:
        response.decision === 'approved' && response.scope === 'session'
          ? 'approved_for_session'
          : response.decision,
      approval_surface: display.kind,
      duration_ms: Date.now() - startedAt,
      session_cache_written: sessionApprovalRule !== undefined,
      has_feedback:
        response.feedback !== undefined && response.feedback.length > 0,
      trace_id: context.trace?.traceId,
    });

    const resolved = result.resolveApproval?.(response);
    if (resolved !== undefined) {
      return this.resolvePermissionResolution(resolved, context, origin);
    }

    if (response.decision === 'approved') return undefined;
    return {
      veto: denyToolExecution(
        this.formatApprovalRejectionMessage(name, response),
      ),
    };
  }

  formatApprovalRejectionMessage(
    toolName: string,
    result: Pick<ApprovalResponse, 'decision' | 'feedback'>,
  ): string {
    const suffix =
      result.feedback !== undefined && result.feedback.length > 0
        ? ` Reason: ${result.feedback}`
        : '';
    const prefix =
      result.decision === 'cancelled'
        ? `Tool "${toolName}" was not run because the approval request was cancelled.`
        : `Tool "${toolName}" was not run because the user rejected the approval request.`;
    if (this.usesWorkerRejectionGuidance()) {
      return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `${prefix}${suffix}`;
  }

  formatDenyMessage(message: string): string {
    if (this.usesWorkerRejectionGuidance()) {
      return `${message} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return message;
  }

  private usesWorkerRejectionGuidance(): boolean {
    return this.scopeContext.agentId !== 'main';
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolApprovalService,
  AgentToolApprovalService,
  ScopeActivation.OnScopeCreated,
  'toolApproval',
);
