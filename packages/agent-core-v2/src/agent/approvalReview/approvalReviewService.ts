import { IHeadlessRun } from '#/app/headlessRun/control';
import { randomUUID } from 'node:crypto';
import {
  constants,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { abortable, createDeadlineAbortSignal } from '#/_base/utils/abort';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  readRetryAfterMs,
  retryBackoffDelay,
  retryErrorFields,
  sleepForRetry,
} from '#/_base/utils/retry';
import { ILogService } from '#/_base/log/log';
import { unwrapErrorCause } from '#/errors';
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
import { isRetryableGenerateError } from '#/llm-adapter/contract/errors';
import { createUserMessage, extractText } from '#/llm-adapter/contract/message';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import { interactions } from '#/human/interaction/facade';
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
  REVIEW_POLICY,
  reviewAuthorization,
  reviewEvidence,
  type ReviewGrant,
  type VerifiedHumanApproval,
  type ReviewVerdict,
  type ReviewSource,
  type ReviewStage,
} from './classifier';

interface DenialChallenge {
  challenge: string;
  toolCallId: string;
  fingerprint: string;
  sessionId: string;
  agentId: string;
  revision: number;
  permissionRevision: number;
  toolName: string;
  args: unknown;
  cwd: string;
  reason: string;
}

const rejectedReview = (
  reason: string,
  source: ReviewSource = 'policy',
): ReviewVerdict => ({
  decision: 'deny',
  risk: 'high',
  authorization: 'unknown',
  reason,
  source,
});

const REVIEW_FAILURE_COOLDOWN_MS = 30_000;
const independentStepGuidance =
  'You may split the work only into smaller, independently verifiable actions that do not produce the denied effect, and submit each action for fresh review.';
const isInfrastructureFailure = (source: ReviewSource | undefined): boolean =>
  source === 'reviewer' || source === 'timeout' || source === 'audit';
const countsTowardStop = (decision: ReviewVerdict): boolean =>
  decision.decision === 'deny' &&
  decision.source !== 'evidence' &&
  !isInfrastructureFailure(decision.source);

const denialGuidance = (
  source: ReviewSource,
  overrideAvailable = false,
): string => {
  if (source === 'evidence')
    return `You may read the relevant scripts or provide complete evidence and exact user authorization before retrying. ${independentStepGuidance} Do not accomplish the same denied effect through another tool, script, encoding or delegation.`;
  if (isInfrastructureFailure(source))
    return 'This is an infrastructure failure, not a safety verdict. Retry after a short backoff. Repeated failures impose a 30-second cooldown, not a turn stop; wait for the cooldown before trying again. Do not treat failures as proof that the action is dangerous.';
  if (source === 'authorization')
    return `Ask the user to reconfirm the exact action and scope before retrying; do not rely on the previous authorization. ${independentStepGuidance}`;
  if (source === 'model' && overrideAvailable)
    return `Do not accomplish the same denied effect through another tool, script, encoding or delegation. In an interactive session, the user may choose /approval approve <toolCallId> to authorize one identical retry that must pass auto-review again. Without that explicit choice, continue unrelated safe work or report the denial. ${independentStepGuidance}`;
  return `Do not accomplish the same denied effect through another tool, script, encoding or delegation. Do not request manual approval for this blocked tool call. ${independentStepGuidance} Continue unrelated safe work, or report why the task cannot proceed.`;
};

export class AgentApprovalReviewService implements IAgentApprovalReviewService {
  declare readonly _serviceBrand: undefined;
  private turnId = -1;
  private failures = 0;
  private retryAfter = 0;
  private denials = 0;
  private recentDecisions: Array<'allow' | ReviewSource> = [];
  private denialChallenges = new Map<string, DenialChallenge>();
  private denialSequence = 0;
  private consumedHumanApprovals = new Set<string>();

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
    @IHeadlessRun private readonly headless?: IHeadlessRun,
  ) {}

  isEnabled(): boolean {
    return (
      this.mode.mode === 'review' && this.flags.enabled(APPROVAL_REVIEW_FLAG)
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
      this.retryAfter = 0;
      this.denials = 0;
      this.recentDecisions = [];
    }
    context.signal.throwIfAborted();
    const startedAt = Date.now();
    const parsedSettings = ApprovalReviewConfigSchema.safeParse(
      this.config.get<PermissionConfig | undefined>('permission')?.review ?? {},
    );
    const resolveModel = (configured: string | undefined): string =>
      configured === '@session' || configured === undefined
        ? this.profile.getModel()
        : configured;
    const model = resolveModel(
      parsedSettings.success ? parsedSettings.data.model : undefined,
    );
    let decision = this.preflightDecision(context, result, origin);
    const fingerprint = evidenceFingerprint({
      tool: context.toolCall.name,
      args: context.args,
      cwd: this.session.cwd,
    });
    let stillCurrent = (): boolean => false;
    let reviewSucceeded = false;
    let oneTimeApproval:
      { toolCallId: string; fingerprint: string } | undefined;
    let humanApproval: VerifiedHumanApproval | undefined;
    if (!parsedSettings.success)
      decision ??= rejectedReview(
        'Review configuration is invalid; this action was denied.',
        'config',
      );
    if (decision === undefined && parsedSettings.success) {
      const settings = parsedSettings.data;
      const permissionAbort = new AbortController();
      const modeChanged = this.mode.onDidChangeMode?.(() => {
        permissionAbort.abort();
      });
      const deadline = createDeadlineAbortSignal(
        AbortSignal.any([context.signal, permissionAbort.signal]),
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
        const readAuthorization = () =>
          reviewAuthorization(
            rootMemory.get(),
            this.authorizationInteractions(),
          );
        const initialAuthorization = readAuthorization();
        const rootRevision = rootMemory.prefixRevision();
        oneTimeApproval = this.headless?.active
          ? undefined
          : this.consumeOneTimeApproval(
              initialAuthorization.grants,
              fingerprint,
              rootRevision,
            );
        humanApproval = this.consumeHumanApproval(
          initialAuthorization.humanApprovals,
          fingerprint,
        );
        const authorization = evidenceFingerprint(initialAuthorization);
        const permissionRules = () => ({
          rules: this.rules.rules,
          sessionApprovalRules: this.rules.sessionApprovalRulePatterns,
        });
        const rules = evidenceFingerprint(permissionRules());
        const action = {
          tool: context.toolCall.name,
          args: context.args,
          cwd: this.session.cwd,
        };
        const fileAccesses = context.execution.accesses?.flatMap((access) => {
          if (access.kind !== 'file') return [];
          try {
            const path = realpathSync(resolve(this.session.cwd, access.path));
            const file = statSync(path);
            return [
              {
                path: access.path,
                operation: access.operation,
                realPath: path,
                links: file.nlink,
                device: file.dev,
                inode: file.ino,
              },
            ];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return [{ path: access.path, operation: access.operation }];
          }
        });
        const evidence = reviewEvidence({
          fileAccesses,
          userRequests: initialAuthorization.requests,
          history: this.contextMemory.get(),
          toolName: action.tool,
          args: action.args,
          cwd: action.cwd,
          agentId: this.scope.agentId,
          maxChars: settings.maxContextChars,
          oneTimeApproval,
          humanApprovals:
            humanApproval === undefined ? undefined : [humanApproval],
          questionAnswers: initialAuthorization.questionAnswers,
        });
        const permissionRevision = this.mode.revision;
        stillCurrent = (): boolean => {
          const currentSettings = ApprovalReviewConfigSchema.safeParse(
            this.config.get<PermissionConfig | undefined>('permission')
              ?.review ?? {},
          );
          return (
            currentSettings.success &&
            authorization === evidenceFingerprint(readAuthorization()) &&
            (oneTimeApproval === undefined ||
              rootRevision === rootMemory.prefixRevision()) &&
            fingerprint ===
              evidenceFingerprint({
                tool: context.toolCall.name,
                args: context.args,
                cwd: this.session.cwd,
              }) &&
            rules === evidenceFingerprint(permissionRules()) &&
            this.isEnabled() &&
            this.mode.revision === permissionRevision &&
            JSON.stringify(settings) === JSON.stringify(currentSettings.data) &&
            model === resolveModel(currentSettings.data.model)
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
              {
                maxAttempts: DEFAULT_MAX_RETRY_ATTEMPTS,
                shouldRetry: (error) =>
                  !deadline.signal.aborted &&
                  isRetryableGenerateError(unwrapErrorCause(error)),
                onRetry: async (error, failedAttempt) => {
                  const cause = unwrapErrorCause(error);
                  this.progress(
                    context,
                    `Retrying (${failedAttempt + 1}/${DEFAULT_MAX_RETRY_ATTEMPTS}) · ${retryErrorFields(cause).errorName}`,
                  );
                  await sleepForRetry(
                    readRetryAfterMs(cause) ??
                      retryBackoffDelay(failedAttempt - 1),
                    deadline.signal,
                  );
                },
              },
            ),
          ),
          deadline.signal,
        );
        context.signal.throwIfAborted();
        if (!stillCurrent()) {
          decision = rejectedReview(
            'Authorization or review settings changed during review; this action was denied.',
            'authorization',
          );
        }
        reviewSucceeded = true;
      } catch {
        context.signal.throwIfAborted();
        decision = rejectedReview(
          permissionAbort.signal.aborted
            ? 'Permission mode changed during review; this action was denied.'
            : deadline.signal.aborted
              ? 'Review timed out; this action was denied without a safety verdict.'
              : phase === 'evidence'
                ? 'Verified human authorization or complete review evidence is unavailable; this action was denied.'
                : 'Reviewer unavailable or returned an invalid or incomplete response; this action was denied.',
          permissionAbort.signal.aborted
            ? 'authorization'
            : deadline.signal.aborted
              ? 'timeout'
              : phase === 'evidence'
                ? 'evidence'
                : 'reviewer',
        );
        if (isInfrastructureFailure(decision.source))
          this.recordInfrastructureFailure();
      } finally {
        modeChanged?.dispose();
        deadline.clear();
      }
    }
    decision ??= rejectedReview(
      'Review could not authorize this action.',
      'reviewer',
    );
    decision.source ??= 'model';
    let safetyDecision = decision;
    const recentDenials = (current: ReviewVerdict) =>
      this.recentDecisions.slice(-49).filter((value) => value !== 'allow')
        .length + (current.decision === 'deny' ? 1 : 0);
    const recentSafetyDenials = (current: ReviewVerdict) =>
      this.recentDecisions
        .slice(-49)
        .filter(
          (value) =>
            value !== 'allow' &&
            value !== 'evidence' &&
            !isInfrastructureFailure(value),
        ).length + (countsTowardStop(current) ? 1 : 0);
    const stopsTurn = (current: ReviewVerdict) =>
      countsTowardStop(current) &&
      (this.denials + 1 >= 3 || recentSafetyDenials(current) >= 10);
    const auditUnavailable = () => {
      this.log.warn('approval review audit unavailable', {
        toolCallId: context.toolCall.id,
      });
      this.recordInfrastructureFailure();
      decision = rejectedReview(
        'The review audit could not be recorded; this action was denied.',
        'audit',
      );
    };
    try {
      await this.audit(context, {
        ...decision,
        model,
        fingerprint,
        durationMs: Date.now() - startedAt,
        recentDenials: recentDenials(decision),
        overrideUsed: oneTimeApproval !== undefined,
        humanApprovalUsed: humanApproval !== undefined,
        stopTurn: stopsTurn(decision),
      });
      if (reviewSucceeded) {
        this.failures = 0;
        this.retryAfter = 0;
      }
    } catch {
      auditUnavailable();
    }
    context.signal.throwIfAborted();
    if (decision.decision === 'allow' && !stillCurrent()) {
      decision = rejectedReview(
        'Authorization or review settings changed before execution; this action was denied.',
        'authorization',
      );
      safetyDecision = decision;
      try {
        await this.audit(context, {
          ...decision,
          model,
          fingerprint,
          durationMs: Date.now() - startedAt,
          recentDenials: recentDenials(decision),
          overrideUsed: oneTimeApproval !== undefined,
          humanApprovalUsed: humanApproval !== undefined,
          stopTurn: stopsTurn(decision),
        });
      } catch {
        auditUnavailable();
      }
    }
    context.signal.throwIfAborted();
    const stopTurn = stopsTurn(safetyDecision);
    this.denials = countsTowardStop(safetyDecision) ? this.denials + 1 : 0;
    const history =
      decision === safetyDecision
        ? [safetyDecision]
        : [safetyDecision, decision];
    for (const current of history)
      this.recentDecisions.push(
        current.decision === 'allow' ? 'allow' : (current.source ?? 'model'),
      );
    while (this.recentDecisions.length > 50) this.recentDecisions.shift();
    let challenge: DenialChallenge | undefined;
    if (decision.decision === 'allow') {
      for (const record of this.denialChallenges.values())
        if (record.fingerprint === fingerprint)
          this.denialChallenges.delete(record.toolCallId);
    } else if (
      !this.headless?.active &&
      decision.source === 'model' &&
      decision.risk !== 'critical'
    ) {
      challenge = this.registerDenialChallenge(
        context,
        fingerprint,
        decision.reason,
      );
    }
    for (const record of this.denialChallenges.values())
      if (
        record.revision !== this.contextMemory.prefixRevision() ||
        record.permissionRevision !== this.mode.revision
      )
        this.denialChallenges.delete(record.toolCallId);
    this.progress(
      context,
      `Auto-review ${decision.decision === 'allow' ? 'approved' : 'denied'}: ${decision.reason}${stopTurn ? ' Turn stopped after repeated safety denials.' : ''}`,
      this.scope.agentId !== 'main'
        ? undefined
        : {
            kind: 'one_time_approval_state',
            version: 1,
            toolCallId: context.toolCall.id,
            agentId: this.scope.agentId,
            sequence: ++this.denialSequence,
            denials: [...this.denialChallenges.values()],
          },
    );
    if (decision.decision === 'deny')
      this.headless?.reportDenial(
        context.toolCall.id,
        context.toolCall.name,
        decision.reason,
      );
    this.headless?.review(
      countsTowardStop(safetyDecision),
      decision.decision === 'allow',
    );
    if (decision.decision === 'allow') return { kind: 'approve' };
    return {
      kind: 'deny',
      message: `Auto-review denied this action: ${decision.reason}${stopTurn ? ' Turn stopped after repeated safety denials.' : ''} ${denialGuidance(decision.source ?? 'model', challenge !== undefined)}`,
      stopTurn,
    };
  }

  private authorizationInteractions() {
    return interactions.findAll({
      resolved: true,
      tags: { sessionId: this.session.sessionId, agentId: 'main' },
    });
  }

  consumeApprovedInteraction(interactionId: string): void {
    this.consumedHumanApprovals.add(interactionId);
  }

  private consumeHumanApproval(
    approvals: readonly VerifiedHumanApproval[],
    fingerprint: string,
  ): VerifiedHumanApproval | undefined {
    if (this.scope.agentId !== 'main') return undefined;
    const originalToolCalls = new Set(
      this.contextMemory
        .get()
        .flatMap((message) =>
          message.role === 'assistant'
            ? message.toolCalls.map((call) => call.id)
            : [],
        ),
    );
    for (const approval of approvals.toReversed()) {
      if (
        approval.fingerprint !== fingerprint ||
        this.consumedHumanApprovals.has(approval.interactionId) ||
        (approval.scope !== 'session' &&
          originalToolCalls.has(approval.toolCallId))
      )
        continue;
      if (approval.scope === 'session') {
        if (
          approval.approvalRule !== undefined &&
          this.rules.sessionApprovalRulePatterns.includes(approval.approvalRule)
        )
          return approval;
        continue;
      }
      this.consumedHumanApprovals.add(approval.interactionId);
      return approval;
    }
    return undefined;
  }

  private consumeOneTimeApproval(
    grants: readonly ReviewGrant[],
    fingerprint: string,
    revision: number,
  ): { toolCallId: string; fingerprint: string } | undefined {
    if (this.scope.agentId !== 'main') return undefined;
    for (const record of this.denialChallenges.values())
      if (
        record.revision !== revision ||
        record.permissionRevision !== this.mode.revision
      )
        this.denialChallenges.delete(record.toolCallId);
    for (const grant of grants) {
      const record = this.denialChallenges.get(grant.toolCallId);
      if (
        record === undefined ||
        record.challenge !== grant.challenge ||
        record.fingerprint !== grant.fingerprint ||
        grant.fingerprint !== fingerprint ||
        record.revision !== revision ||
        record.permissionRevision !== this.mode.revision ||
        record.sessionId !== this.session.sessionId ||
        record.agentId !== this.scope.agentId
      )
        continue;
      this.denialChallenges.delete(record.toolCallId);
      return {
        toolCallId: record.toolCallId,
        fingerprint: record.fingerprint,
      };
    }
    return undefined;
  }

  private registerDenialChallenge(
    context: ResolvedToolExecutionHookContext,
    fingerprint: string,
    reason: string,
  ): DenialChallenge | undefined {
    if (this.scope.agentId !== 'main') return undefined;
    for (const record of this.denialChallenges.values())
      if (record.fingerprint === fingerprint)
        this.denialChallenges.delete(record.toolCallId);
    const record: DenialChallenge = {
      challenge: randomUUID(),
      toolCallId: context.toolCall.id,
      fingerprint,
      sessionId: this.session.sessionId,
      agentId: this.scope.agentId,
      revision: this.contextMemory.prefixRevision(),
      permissionRevision: this.mode.revision,
      toolName: context.toolCall.name,
      args: context.args,
      cwd: this.session.cwd,
      reason,
    };
    this.denialChallenges.set(record.toolCallId, record);
    while (this.denialChallenges.size > 10) {
      const oldest = this.denialChallenges.keys().next().value;
      if (oldest !== undefined) this.denialChallenges.delete(oldest);
    }
    return record;
  }

  private recordInfrastructureFailure(): void {
    this.failures += 1;
    if (this.failures >= 2)
      this.retryAfter = Date.now() + REVIEW_FAILURE_COOLDOWN_MS;
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
    if (this.failures >= 2) {
      if (Date.now() < this.retryAfter)
        return rejectedReview(
          'Review retries are cooling down after repeated infrastructure failures. Retry after the cooldown; this action was denied without a safety verdict.',
          'reviewer',
        );
      this.failures = 0;
      this.retryAfter = 0;
    }
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
        systemPrompt: `${REVIEW_POLICY}\n${policy === undefined ? '' : `Additional trusted operator policy:\n${policy}\n`}`,
        tools: [],
        messages: [
          createUserMessage(
            `${evidence}\nReview stage: ${stage === 'fast' ? 'Fast screen. If uncertain, return ask for an independent full review.' : 'Careful independent final review. Reassess the evidence without relying on a prior verdict. Return allow or deny; if uncertainty remains, deny and explain why.'}`,
          ),
        ],
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
    for (const access of context.execution.accesses ?? []) {
      if (access.kind !== 'file' || access.operation === 'read') continue;
      try {
        const file = statSync(access.path);
        if (file.isFile() && file.nlink !== 1) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
    }
    const protectedPath = (path: string): boolean => {
      const matches = (candidate: string): boolean => {
        const fromHome = relative(this.bootstrap.homeDir, candidate);
        return (
          (!isAbsolute(fromHome) &&
            fromHome !== '..' &&
            !fromHome.startsWith(
              `..${process.platform === 'win32' ? '\\' : '/'}`,
            )) ||
          /(?:^|[/\\])(?:\.kimi-code|\.agents|AGENTS\.md|CLAUDE\.md|KIMI\.md)(?:[/\\]|$)/i.test(
            candidate,
          )
        );
      };
      let current = resolve(this.session.cwd, path);
      const seen = new Set<string>();
      while (true) {
        if (seen.has(current)) return true;
        seen.add(current);
        if (matches(current)) return true;
        try {
          return matches(realpathSync(current));
        } catch {
          try {
            current = resolve(current, '..', readlinkSync(current));
            continue;
          } catch {}
        }
        const parent = resolve(current, '..');
        if (parent === current) return false;
        current = parent;
      }
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
    customData?: unknown,
  ): void {
    void this.dispatcher.dispatch(
      new ToolProgress({
        agentId: this.scope.agentId,
        turnId: context.turnId,
        toolCallId: context.toolCall.id,
        update: {
          kind: 'status',
          customKind: 'approval.review',
          text,
          customData,
        },
      }),
    );
  }

  private async audit(
    context: ResolvedToolExecutionHookContext,
    decision: ReviewVerdict & {
      model: string;
      fingerprint: string;
      durationMs: number;
      recentDenials: number;
      overrideUsed: boolean;
      humanApprovalUsed: boolean;
      stopTurn: boolean;
    },
  ): Promise<void> {
    await mkdir(this.session.sessionDir, { recursive: true, mode: 0o700 });
    const file = await open(
      join(this.session.sessionDir, 'approval-review.jsonl'),
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    const reason =
      decision.source === 'model'
        ? 'Model decision; see the session transcript for its reason.'
        : decision.reason;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error('Unsafe review audit file');
      await file.writeFile(
        `${JSON.stringify({ timestamp: new Date().toISOString(), agentId: this.scope.agentId, turnId: context.turnId, toolCallId: context.toolCall.id, tool: context.toolCall.name, ...decision, reason })}\n`,
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
