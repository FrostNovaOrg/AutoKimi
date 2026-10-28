import { IFlagService } from '#/app/flag/flag';
import { APPROVAL_REVIEW_FLAG } from '#/agent/approvalReview/config';
import { IHeadlessRun, HEADLESS_SAFE_TOOLS } from '#/app/headlessRun/control';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionData } from '#/agent/permissionPolicy/types';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import { IAgentPermissionGate } from './permissionGate';

export class AgentPermissionGate extends Service implements IAgentPermissionGate {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService,
    @IAgentPermissionPolicyService private readonly policyService: IAgentPermissionPolicyService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IFlagService private readonly flags: IFlagService,
    @IHeadlessRun private readonly headless?: IHeadlessRun,
  ) {
    super();
    this._register(toolExecutor.onBeforeExecuteTool((event) => this.adjudicate(event)));
  }

  data(): PermissionData {
    return {
      mode: this.modeService.mode,
      rules: [...this.rulesService.rules],
    };
  }

  private async adjudicate(event: BeforeToolExecuteEvent): Promise<void> {
    if (this.modeService.mode === 'review' && !this.flags.enabled(APPROVAL_REVIEW_FLAG)) {
      event.veto({ output: 'Auto Review is unavailable; this action was denied.', isError: true, stopTurn: true });
      return;
    }
    const blocked = this.headless?.toolPolicy(event);
    if (blocked !== undefined) {
      event.veto({ output: blocked, isError: true });
      return;
    }
    const evaluation = await this.policyService.evaluate(event);
    if (evaluation === undefined) return;
    this.telemetry.track2('permission_policy_decision', {
      turn_id: event.turnId,
      tool_call_id: event.toolCall.id,
      policy_name: evaluation.policyName,
      tool_name: event.toolCall.name,
      permission_mode: this.modeService.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
    const { result, policyName } = evaluation;
    if (result.kind === 'deny') this.headless?.reportDenial(event.toolCall.id, event.toolCall.name, result.message ?? 'Permission rule denied this action.');
    if (result.kind === 'ask') {
      event.waitUntil(() => this.toolApproval.requestToolApproval(event, result, policyName));
      return;
    }
    if (result.kind === 'approve' && this.requiresHeadlessReview(event)) {
      event.waitUntil(() => this.toolApproval.requestToolApproval(event, { kind: 'ask' }, 'reviewed-headless'));
      return;
    }
    if (result.kind === 'approve') {
      event.pass(result.executionMetadata);
      return;
    }
    const resolved = await this.toolApproval.resolvePermissionResolution(result, event, policyName);
    if (resolved?.veto !== undefined) {
      event.veto(resolved.veto);
    }
  }

  private requiresHeadlessReview(context: ResolvedToolExecutionHookContext): boolean {
    return this.headless?.active === true && !HEADLESS_SAFE_TOOLS.has(context.toolCall.name);
  }

  async authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    if (this.modeService.mode === 'review' && !this.flags.enabled(APPROVAL_REVIEW_FLAG))
      return { veto: { output: 'Auto Review is unavailable; this action was denied.', isError: true, stopTurn: true } };
    const blocked = this.headless?.toolPolicy(context);
    if (blocked !== undefined) return { veto: { output: blocked, isError: true } };
    const evaluation = await this.policyService.evaluate(context);
    if (evaluation === undefined) return undefined;
    this.telemetry.track2('permission_policy_decision', {
      turn_id: context.turnId,
      tool_call_id: context.toolCall.id,
      policy_name: evaluation.policyName,
      tool_name: context.toolCall.name,
      permission_mode: this.modeService.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
    if (evaluation.result.kind === 'deny') this.headless?.reportDenial(context.toolCall.id, context.toolCall.name, evaluation.result.message ?? 'Permission rule denied this action.');
    if (evaluation.result.kind === 'approve' && this.requiresHeadlessReview(context))
      return this.toolApproval.requestToolApproval(context, { kind: 'ask' }, 'reviewed-headless');
    return this.toolApproval.resolvePermissionResolution(
      evaluation.result,
      context,
      evaluation.policyName,
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionGate,
  AgentPermissionGate,
  ScopeActivation.OnScopeCreated,
  'permissionGate',
);
