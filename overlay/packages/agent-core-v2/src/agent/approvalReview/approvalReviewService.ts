import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { abortable, createDeadlineAbortSignal } from '#/_base/utils/abort';
import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { evaluateUserConfiguredRule } from '#/agent/permissionPolicy/policies/user-configured-rule';
import type { PermissionConfig } from '#/agent/permissionRules/configSection';
import type { PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ToolProgress } from '#/agent/toolExecutor/toolExecutorEvents';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { createUserMessage, extractText } from '#/llm-adapter/contract/message';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  IAgentApprovalReviewService,
  type ApprovalReviewResult,
} from './approvalReview';
import { APPROVAL_REVIEW_FLAG, ApprovalReviewConfigSchema } from './config';
import {
  classifyApproval,
  evidenceFingerprint,
  genuineUserRequests,
  REVIEW_POLICY,
  reviewEvidence,
  type ReviewVerdict,
  type ReviewStage,
} from './classifier';

const rejectedReview = (reason: string): ReviewVerdict => ({
  decision: 'deny',
  risk: 'high',
  authorization: 'unknown',
  reason,
});

export class AgentApprovalReviewService implements IAgentApprovalReviewService {
  declare readonly _serviceBrand: undefined;
  private turnId = -1;
  private failures = 0;
  private denials = 0;

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IConfigService private readonly config: IConfigService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentPermissionModeService
    private readonly mode: IAgentPermissionModeService,
    @IAgentPermissionRulesService
    private readonly rules: IAgentPermissionRulesService,
    @IAgentContextMemoryService
    private readonly contextMemory: IAgentContextMemoryService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly models: IModelCatalog,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ILogService private readonly log: ILogService,
  ) {}

  isEnabled(): boolean {
    return (
      this.flags.enabled(APPROVAL_REVIEW_FLAG) && this.mode.mode === 'manual'
    );
  }

  async review(
    context: ResolvedToolExecutionHookContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    origin: string,
  ): Promise<ApprovalReviewResult> {
    if (this.turnId !== context.turnId) {
      this.turnId = context.turnId;
      this.failures = 0;
      this.denials = 0;
    }
    context.signal.throwIfAborted();
    const startedAt = Date.now();
    const parsedSettings = ApprovalReviewConfigSchema.safeParse(
      this.config.get<PermissionConfig | undefined>('permission')?.review ?? {},
    );
    const model =
      (parsedSettings.success ? parsedSettings.data.model : undefined) ??
      this.profile.getModel();
    let decision = this.preflightDecision(context, result, origin);
    const fingerprint = evidenceFingerprint({
      tool: context.toolCall.name,
      args: context.args,
      cwd: this.session.cwd,
    });
    let stillCurrent = (): boolean => false;
    let reviewSucceeded = false;
    if (!parsedSettings.success)
      decision ??= rejectedReview(
        'Review configuration is invalid; this action was denied.',
      );
    if (decision === undefined && parsedSettings.success) {
      const settings = parsedSettings.data;
      const deadline = createDeadlineAbortSignal(
        context.signal,
        settings.timeoutMs,
      );
      let phase: 'evidence' | 'model' = 'evidence';
      this.progress(context, 'Reviewing permission with model…');
      try {
        const rootMemory =
          this.scope.agentId === 'main'
            ? this.contextMemory
            : this.agents
                .handleOf('main')
                ?.accessor.get(IAgentContextMemoryService);
        if (rootMemory === undefined)
          throw new Error('Root authorization unavailable');
        const requests = genuineUserRequests(rootMemory.get());
        const authorization = evidenceFingerprint(requests);
        const rules = evidenceFingerprint(this.rules.rules);
        const action = {
          tool: context.toolCall.name,
          args: context.args,
          cwd: this.session.cwd,
        };
        const evidence = reviewEvidence({
          userRequests: requests,
          history: this.contextMemory.get(),
          toolName: action.tool,
          args: action.args,
          cwd: action.cwd,
          agentId: this.scope.agentId,
          maxChars: settings.maxContextChars,
        });
        stillCurrent = (): boolean => {
          const currentSettings = ApprovalReviewConfigSchema.safeParse(
            this.config.get<PermissionConfig | undefined>('permission')
              ?.review ?? {},
          );
          return (
            currentSettings.success &&
            authorization ===
              evidenceFingerprint(genuineUserRequests(rootMemory.get())) &&
            fingerprint ===
              evidenceFingerprint({
                tool: context.toolCall.name,
                args: context.args,
                cwd: this.session.cwd,
              }) &&
            rules === evidenceFingerprint(this.rules.rules) &&
            this.isEnabled() &&
            JSON.stringify(settings) === JSON.stringify(currentSettings.data) &&
            model === (currentSettings.data.model ?? this.profile.getModel())
          );
        };
        phase = 'model';
        decision = await abortable(
          Promise.resolve().then(() =>
            classifyApproval(
              (stage) =>
                this.runModel(
                  model,
                  stage,
                  evidence,
                  settings.policy,
                  deadline.signal,
                ),
              settings.twoStage,
            ),
          ),
          deadline.signal,
        );
        context.signal.throwIfAborted();
        if (!stillCurrent()) {
          decision = rejectedReview(
            'Authorization or review settings changed during review; this action was denied.',
          );
        }
        reviewSucceeded = true;
      } catch {
        context.signal.throwIfAborted();
        this.failures += 1;
        decision = rejectedReview(
          deadline.signal.aborted
            ? 'Review timed out; this action was denied without a safety verdict.'
            : phase === 'evidence'
              ? 'Verified human authorization or complete review evidence is unavailable; this action was denied.'
              : 'Reviewer unavailable or returned an invalid or incomplete response; this action was denied.',
        );
      } finally {
        deadline.clear();
      }
    }
    decision ??= rejectedReview('Review could not authorize this action.');
    try {
      await this.audit(context, {
        ...decision,
        model,
        fingerprint,
        durationMs: Date.now() - startedAt,
        stopTurn:
          decision.decision === 'deny' &&
          (this.denials + 1 >= 3 || this.failures >= 2),
      });
      if (reviewSucceeded) this.failures = 0;
    } catch {
      this.log.warn('approval review audit unavailable', {
        toolCallId: context.toolCall.id,
      });
      this.failures += 1;
      decision = rejectedReview(
        'The review audit could not be recorded; this action was denied.',
      );
    }
    context.signal.throwIfAborted();
    if (decision.decision === 'allow' && !stillCurrent()) {
      decision = rejectedReview(
        'Authorization or review settings changed before execution; this action was denied.',
      );
      try {
        await this.audit(context, {
          ...decision,
          model,
          fingerprint,
          durationMs: Date.now() - startedAt,
          stopTurn: this.denials + 1 >= 3 || this.failures >= 2,
        });
      } catch {
        this.log.warn('approval review audit unavailable', {
          toolCallId: context.toolCall.id,
        });
      }
    }
    context.signal.throwIfAborted();
    this.denials = decision.decision === 'deny' ? this.denials + 1 : 0;
    const stopTurn =
      decision.decision === 'deny' && (this.denials >= 3 || this.failures >= 2);
    this.progress(
      context,
      `Auto-review ${decision.decision === 'allow' ? 'approved' : 'denied'}: ${decision.reason}${stopTurn ? ' Turn stopped after repeated review denials or failures.' : ''}`,
    );
    if (decision.decision === 'allow') return { kind: 'approve' };
    return {
      kind: 'deny',
      message: `Auto-review denied this action: ${decision.reason}${stopTurn ? ' Turn stopped after repeated review denials or failures.' : ''} Do not accomplish the same denied action through another tool, script, encoding or delegation. Do not request manual approval for this blocked tool call. Continue unrelated safe work, or report why the task cannot proceed.`,
      stopTurn,
    };
  }

  private preflightDecision(
    context: ResolvedToolExecutionHookContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    origin: string,
  ): ReviewVerdict | undefined {
    if (!this.isEnabled())
      return rejectedReview(
        'Auto-review is no longer active; the pending action was denied.',
      );
    if (
      origin === 'user-configured-ask' ||
      evaluateUserConfiguredRule(context, 'ask', this.rules) !== undefined
    )
      return rejectedReview(
        'An explicit ask permission rule requires human approval; auto-review denies this action without opening a permission prompt.',
      );
    if (
      result.resolveApproval !== undefined ||
      result.resolveError !== undefined
    )
      return rejectedReview(
        'This tool requires a custom approval interaction that auto-review cannot authorize.',
      );
    if (this.failures >= 2)
      return rejectedReview(
        'Reviewer failure limit reached for this turn; this action was denied.',
      );
    if (this.protectedAction(context))
      return rejectedReview(
        'This action accesses protected agent instructions or reviewer configuration and cannot be automatically authorized.',
      );
    return undefined;
  }

  private async runModel(
    modelId: string,
    stage: ReviewStage,
    evidence: string,
    policy: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const model = this.models.get(modelId);
    let text = '';
    let finished = false;
    for await (const event of this.models.generate(
      modelId,
      {
        systemPrompt: `${REVIEW_POLICY}\n${policy === undefined ? '' : `Additional trusted operator policy:\n${policy}\n`}Review stage: ${stage === 'fast' ? 'Fast screen. If uncertain, return ask for an independent full review.' : 'Careful independent final review. Reassess the evidence without relying on a prior verdict. Return allow or deny; if uncertainty remains, deny and explain why.'}`,
        tools: [],
        messages: [createUserMessage(evidence)],
      },
      signal,
      {
        thinkingEffort: model.alwaysThinking
          ? model.supportEfforts?.includes('low')
            ? 'low'
            : (model.defaultEffort ?? 'on')
          : 'off',
        maxCompletionTokens: Math.min(
          model.maxOutputSize ?? 4096,
          stage === 'fast' ? 2048 : 4096,
        ),
      },
    )) {
      signal.throwIfAborted();
      if (event.type === 'usage')
        await this.usage.record(this.scope.agentContext, modelId, event.usage, {
          type: 'operation',
          requestKind: 'approval_review',
        });
      if (event.type === 'finish') {
        if (
          event.message.toolCalls.length > 0 ||
          event.providerFinishReason === 'truncated' ||
          event.providerFinishReason === 'filtered'
        )
          throw new Error('Incomplete reviewer response');
        text = extractText(event.message);
        finished = true;
      }
    }
    if (!finished || text.length > 8192)
      throw new Error('Invalid reviewer output');
    return text;
  }

  private protectedAction(context: ResolvedToolExecutionHookContext): boolean {
    const protectedPath = (path: string): boolean => {
      const full = resolve(this.session.cwd, path);
      const fromHome = relative(this.bootstrap.homeDir, full);
      return (
        (!isAbsolute(fromHome) &&
          fromHome !== '..' &&
          !fromHome.startsWith(
            `..${process.platform === 'win32' ? '\\' : '/'}`,
          )) ||
        /(?:^|[/\\])(?:\.kimi-code|\.agents|AGENTS\.md|CLAUDE\.md|KIMI\.md)(?:[/\\]|$)/i.test(
          full,
        )
      );
    };
    if (
      context.execution.accesses?.some(
        (access) => access.kind === 'file' && protectedPath(access.path),
      )
    )
      return true;
    return /(?:\.kimi-code|\.agents[/\\]|AGENTS\.md|CLAUDE\.md|KIMI\.md|KIMI_CODE_EXPERIMENTAL_APPROVAL_REVIEW)/i.test(
      JSON.stringify(context.args),
    );
  }

  private progress(
    context: ResolvedToolExecutionHookContext,
    text: string,
  ): void {
    void this.dispatcher.dispatch(
      new ToolProgress({
        agentId: this.scope.agentId,
        turnId: context.turnId,
        toolCallId: context.toolCall.id,
        update: { kind: 'status', customKind: 'approval.review', text },
      }),
    );
  }

  private async audit(
    context: ResolvedToolExecutionHookContext,
    decision: ReviewVerdict & {
      model: string;
      fingerprint: string;
      durationMs: number;
      stopTurn: boolean;
    },
  ): Promise<void> {
    await mkdir(this.session.sessionDir, { recursive: true, mode: 0o700 });
    const file = await open(
      join(this.session.sessionDir, 'approval-review.jsonl'),
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(
        `${JSON.stringify({ timestamp: new Date().toISOString(), agentId: this.scope.agentId, turnId: context.turnId, toolCallId: context.toolCall.id, tool: context.toolCall.name, ...decision })}\n`,
      );
    } finally {
      await file.close();
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentApprovalReviewService,
  AgentApprovalReviewService,
  ScopeActivation.OnDemand,
  'approvalReview',
);
