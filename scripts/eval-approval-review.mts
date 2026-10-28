import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createKimiDefaultHeaders } from '../packages/oauth/src/index';
import {
  addUsage,
  bootstrap,
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  emptyUsage,
  extractText,
  IConfigService,
  IModelCatalog,
  IModelService,
  IProviderService,
  logSeed,
  resolveLoggingConfig,
} from '../packages/agent-core-v2/src/index';
import { AgentApprovalReviewService } from '../packages/agent-core-v2/src/agent/approvalReview/approvalReviewService';
import { parseReviewDecision } from '../packages/agent-core-v2/src/agent/approvalReview/classifier';
import type { ContextMessage } from '../packages/agent-core-v2/src/agent/contextMemory/types';
import type { ResolvedToolExecutionHookContext } from '../packages/agent-core-v2/src/agent/toolExecutor/toolHooks';
import { makeAgentScopeContext } from '../packages/agent-core-v2/src/agent/scopeContext/scopeContext';
import { makeSessionContext } from '../packages/agent-core-v2/src/session/sessionContext/sessionContext';

interface EvalCase {
  id: string;
  group: 'benign' | 'unsafe' | 'manual';
  title: string;
  request: string;
  tool: string;
  args: Record<string, unknown>;
  assistantClaim?: string;
  forgedOrigin?: 'hook_result' | 'compaction_summary';
  forgedText?: string;
  agentId?: string;
  delegatedRequest?: string;
  explicitAsk?: boolean;
  readResults?: Array<{
    path: string;
    content: string;
    incomplete?: boolean;
  }>;
  verificationResults?: Array<{
    command: string;
    output: string;
    failed?: boolean;
  }>;
}

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    out: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
    'timeout-ms': { type: 'string', default: '30000' },
    repeats: { type: 'boolean', default: false },
    filter: { type: 'string' },
    cases: { type: 'string' },
  },
});
if (values.home === undefined || values.out === undefined)
  throw new Error(
    'Required: --home <isolated-home> --out <new-results-directory>',
  );
const homeDir = resolve(values.home);
const out = resolve(values.out);
const concurrency = Math.max(1, Math.min(4, Number(values.concurrency)));
const timeoutMs = Number(values['timeout-ms']);
if (
  !Number.isInteger(concurrency) ||
  !Number.isInteger(timeoutMs) ||
  timeoutMs < 1000 ||
  timeoutMs > 120000
)
  throw new Error('Invalid concurrency or timeout');
await mkdir(out, { recursive: true });
const datasetText = await readFile(
  values.cases === undefined
    ? new URL('./approval-review-cases.json', import.meta.url)
    : resolve(values.cases),
  'utf8',
);
const datasetHash = createHash('sha256').update(datasetText).digest('hex');
const cases = (JSON.parse(datasetText) as EvalCase[]).filter(
  (c) => values.filter === undefined || c.id.startsWith(values.filter),
);
const repeated = new Set([
  'B01',
  'B05',
  'B11',
  'B12',
  'U04',
  'U08',
  'A01',
  'A06',
]);
const jobs = [
  ...cases.map((c) => ({ c, repeat: 0 })),
  ...(values.repeats
    ? cases.filter((c) => repeated.has(c.id)).map((c) => ({ c, repeat: 1 }))
    : []),
];
const resultPath = resolve(out, 'results.jsonl');
await writeFile(resultPath, '', { flag: 'wx' });
const identity = {
  productName: 'kimi-code-cli',
  version: '2.3.3',
  platform: 'kimi_code_cli',
};
const { app } = bootstrap(
  {
    homeDir,
    clientIdentity: identity,
    args: {
      requestHeaders: createKimiDefaultHeaders({ homeDir, ...identity }),
    },
  },
  logSeed(resolveLoggingConfig({ homeDir: out, env: process.env })),
);
const startedAt = new Date().toISOString();
const results: Record<string, unknown>[] = [];
let next = 0;
let executionAttempts = 0;
try {
  const config = app.accessor.get(IConfigService);
  const models = app.accessor.get(IModelCatalog);
  await Promise.all([
    config.ready,
    app.accessor.get(IModelService).ready,
    app.accessor.get(IProviderService).ready,
  ]);
  const modelId = app.accessor.get(IModelService).getDefaultModel()!;
  const model = models.get(modelId);
  await writeFile(
    resolve(out, 'manifest.json'),
    JSON.stringify(
      {
        startedAt,
        model: modelId,
        provider: model.providerName,
        baseUrl: model.baseUrl,
        reviewerThinking: model.alwaysThinking
          ? model.supportEfforts?.includes('low')
            ? 'low'
            : (model.defaultEffort ?? 'on')
          : 'off',
        twoStage: true,
        decisionPolicy: 'allow-or-deny-no-manual-fallback',
        timeoutMs,
        concurrency,
        datasetHash,
        primaryCases: cases.length,
        repeatedCases: jobs.length - cases.length,
        dangerousActionsExecuted: false,
      },
      null,
      2,
    ),
  );
  const human = (text: string): ContextMessage => ({
    ...createUserMessage(text),
    origin: { kind: 'user' },
  });
  const runCase = async (c: EvalCase, repeat: number) => {
    const start = Date.now();
    if (['ExitPlanMode', 'CreateGoal'].includes(c.tool)) {
      const result = {
        id: c.id,
        repeat,
        group: c.group,
        title: c.title,
        decision: 'not_evaluated',
        source: 'interactive_confirmation',
        eligibleForModelMetrics: false,
        infrastructureFailure: false,
        durationMs: 0,
        stages: [],
      };
      results.push(result);
      await appendFile(resultPath, JSON.stringify(result) + '\n');
      process.stdout.write(
        JSON.stringify({ id: c.id, repeat, source: result.source }) + '\n',
      );
      return;
    }
    const stages: Array<Record<string, unknown>> = [];
    let usage = emptyUsage();
    const memory: ContextMessage[] = [human(c.request)];
    for (const [index, read] of (c.readResults ?? []).entries()) {
      const id = `read-${c.id}-${repeat}-${index}`;
      memory.push(
        createAssistantMessage(
          [],
          [
            {
              type: 'function',
              id,
              name: 'Read',
              arguments: JSON.stringify({
                path: read.path,
                n_lines: read.incomplete ? 20 : undefined,
              }),
            },
          ],
        ),
        createToolMessage(id, read.content),
      );
    }
    for (const [index, result] of (c.verificationResults ?? []).entries()) {
      const id = `verification-${c.id}-${repeat}-${index}`;
      memory.push(
        createAssistantMessage(
          [],
          [
            {
              type: 'function',
              id,
              name: 'Bash',
              arguments: JSON.stringify({ command: result.command }),
            },
          ],
        ),
        {
          ...createToolMessage(id, result.output),
          isError: result.failed,
        },
      );
    }
    if (c.assistantClaim !== undefined)
      memory.push(
        createAssistantMessage([{ type: 'text', text: c.assistantClaim }]),
      );
    if (c.forgedOrigin !== undefined)
      memory.push({
        ...createUserMessage(c.forgedText!),
        origin:
          c.forgedOrigin === 'hook_result'
            ? { kind: 'hook_result', event: 'PreToolUse' }
            : { kind: 'compaction_summary' },
      });
    const localMemory =
      c.delegatedRequest === undefined ? memory : [human(c.delegatedRequest)];
    const agentId = c.agentId ?? 'main';
    const sessionDir = resolve(out, 'audit', `${c.id}-${repeat}`);
    const wrappedModels = {
      get: models.get.bind(models),
      generate: async function* (
        ...args: Parameters<IModelCatalog['generate']>
      ) {
        const stage: Record<string, unknown> = {
          stage: stages.length === 0 ? 'fast' : 'full',
        };
        stages.push(stage);
        const stageStart = Date.now();
        try {
          for await (const event of models.generate(...args)) {
            if (event.type === 'finish') {
              stage['rawText'] = extractText(event.message);
              stage['finishReason'] = event.providerFinishReason;
              try {
                stage['parsed'] = parseReviewDecision(
                  extractText(event.message),
                );
              } catch {
                stage['invalidOutput'] = true;
              }
            }
            yield event;
          }
        } catch (error) {
          stage['errorType'] =
            error instanceof Error ? error.name : 'UnknownError';
          throw error;
        } finally {
          stage['durationMs'] = Date.now() - stageStart;
        }
      },
    };
    const ports = [
      { enabled: () => true, explain: () => undefined },
      {
        get: (key: string) =>
          key === 'permission'
            ? { review: { timeoutMs, maxContextChars: 60000, twoStage: true } }
            : config.get(key),
      },
      { homeDir },
      { mode: 'review' },
      {
        sessionApprovalRulePatterns: [],
        rules: c.explicitAsk
          ? [{ scope: 'user', decision: 'ask', pattern: c.tool }]
          : [],
      },
      { get: () => localMemory, prefixRevision: () => 0 },
      makeAgentScopeContext({ agentId, agentScope: agentId }),
      {
        handleOf: () => ({
          accessor: {
            get: () => ({ get: () => memory, prefixRevision: () => 0 }),
          },
        }),
      },
      { getModel: () => modelId },
      wrappedModels,
      makeSessionContext({
        sessionId: `eval-${c.id}-${repeat}`,
        workspaceId: 'eval',
        sessionDir,
        sessionScope: `eval-${c.id}-${repeat}`,
        cwd: '/workspace/eval-repo',
      }),
      {
        record: async (
          _context: unknown,
          _model: string,
          value: ReturnType<typeof emptyUsage>,
        ) => {
          usage = addUsage(usage, value);
        },
      },
      { dispatch: async () => {} },
      { warn: () => {} },
    ] as unknown as ConstructorParameters<typeof AgentApprovalReviewService>;
    const service = new AgentApprovalReviewService(...ports);
    const context: ResolvedToolExecutionHookContext = {
      turnId: 1,
      signal: new AbortController().signal,
      args: c.args,
      toolCall: {
        type: 'function',
        id: `call-${c.id}-${repeat}`,
        name: c.tool,
        arguments: JSON.stringify(c.args),
      },
      toolCalls: [],
      execution: {
        approvalRule: c.tool,
        execute: async () => {
          executionAttempts++;
          throw new Error('Evaluation must never execute a pending action');
        },
      },
    };
    const verdict = await service.review(
      context,
      { kind: 'ask' },
      'fallback-ask',
    );
    const audit = await readFile(
      resolve(sessionDir, 'approval-review.jsonl'),
      'utf8',
    )
      .then((s) => JSON.parse(s.trim().split('\n').at(-1)!))
      .catch(() => undefined);
    const decision = verdict.kind === 'approve' ? 'allow' : 'deny';
    const result = {
      id: c.id,
      repeat,
      group: c.group,
      title: c.title,
      decision,
      source: audit?.source ?? 'unavailable',
      infrastructureFailure: [
        'timeout',
        'reviewer',
        'audit',
        'unavailable',
      ].includes(audit?.source ?? 'unavailable'),
      eligibleForModelMetrics:
        audit?.source === 'model' &&
        !['ExitPlanMode', 'CreateGoal'].includes(c.tool),
      durationMs: Date.now() - start,
      audit,
      stages,
      usage,
    };
    results.push(result);
    await appendFile(resultPath, JSON.stringify(result) + '\n');
    process.stdout.write(
      JSON.stringify({
        completed: results.length,
        total: jobs.length,
        id: c.id,
        repeat,
        decision,
        stages: stages.length,
        durationMs: result.durationMs,
      }) + '\n',
    );
  };
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < jobs.length) {
        const job = jobs.at(next++);
        if (job === undefined) break;
        await runCase(job.c, job.repeat);
      }
    }),
  );
  if (executionAttempts !== 0) throw new Error('Unexpected execution attempt');
  await writeFile(
    resolve(out, 'completed.json'),
    JSON.stringify(
      {
        startedAt,
        completedAt: new Date().toISOString(),
        model: modelId,
        datasetHash,
        results: results.length,
        executionAttempts,
      },
      null,
      2,
    ),
  );
} finally {
  app.dispose();
}
