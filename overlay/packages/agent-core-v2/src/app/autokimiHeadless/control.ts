import { readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { createDecorator } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import type { ModelRequestEvent } from '#/llm-adapter/model/model-requester';

export const HEADLESS_SAFE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'TaskList',
  'TaskOutput',
  'WaitFor',
  'GetGoal',
  'TodoList',
  'SetTodoList',
  'AskUserQuestion',
]);

export interface HeadlessLimits {
  readonly maxSteps: number;
  readonly maxRequests: number;
  readonly maxTools: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

export interface HeadlessUsage {
  steps: number;
  requests: number;
  tools: number;
  tokens: number;
  elapsedMs: number;
  denials: number;
  consecutiveDenials: number;
  recentDenials: boolean[];
}

export interface HeadlessState {
  readonly usage: HeadlessUsage;
  readonly reason?: string;
  readonly denial?: { toolCallId: string; tool: string; reason: string };
}

export interface HeadlessOptions {
  readonly signal?: AbortSignal;
  readonly protectedDirs?: readonly string[];
  readonly limits: HeadlessLimits;
  readonly initial: HeadlessUsage;
  readonly readOnly: boolean;
  readonly workDir: string;
  readonly allowNetwork: boolean;
  readonly onUpdate: (state: HeadlessState) => void;
}

export type IAutoKimiHeadless = AutoKimiHeadlessControl;

export const IAutoKimiHeadless =
  createDecorator<AutoKimiHeadlessControl>('autokimiHeadless');

export class AutoKimiHeadlessControl extends Disposable {
  declare readonly _serviceBrand: undefined;
  private readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  private readonly usage: HeadlessUsage;
  private reason: string | undefined;
  private denial: HeadlessState['denial'];
  private readonly options: HeadlessOptions | undefined;

  constructor(options?: HeadlessOptions) {
    super();
    this.options =
      options === undefined
        ? undefined
        : {
            ...options,
            workDir: realpathSync(options.workDir),
            limits: Object.freeze({ ...options.limits }),
            initial: {
              ...options.initial,
              recentDenials: [...options.initial.recentDenials],
            },
          };
    this.usage =
      this.options === undefined
        ? {
            steps: 0,
            requests: 0,
            tools: 0,
            tokens: 0,
            elapsedMs: 0,
            denials: 0,
            consecutiveDenials: 0,
            recentDenials: [],
          }
        : {
            ...this.options.initial,
            recentDenials: [...this.options.initial.recentDenials],
          };
    if (this.options !== undefined) {
      for (const value of Object.values(this.options.limits))
        if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff)
          throw new Error('Invalid headless budget');
      for (const value of [
        this.usage.steps,
        this.usage.requests,
        this.usage.tools,
        this.usage.tokens,
        this.usage.elapsedMs,
        this.usage.denials,
        this.usage.consecutiveDenials,
      ])
        if (!Number.isSafeInteger(value) || value < 0)
          throw new Error('Invalid inherited headless usage');
      if (
        this.usage.recentDenials.length > 50 ||
        this.usage.recentDenials.some((value) => typeof value !== 'boolean')
      )
        throw new Error('Invalid inherited denial window');
      const interrupt = () => {
        try {
          this.stop(
            typeof this.options!.signal?.reason?.code === 'string'
              ? this.options!.signal.reason.code
              : 'cancelled',
          );
        } catch {}
      };
      this.options.signal?.addEventListener('abort', interrupt, { once: true });
      this._register({
        dispose: () =>
          this.options?.signal?.removeEventListener('abort', interrupt),
      });
      if (this.options.signal?.aborted) interrupt();
      const remaining = this.options.limits.timeoutMs - this.usage.elapsedMs;
      const timer = setTimeout(
        () => {
          try {
            this.stop('timeout');
          } catch {}
        },
        Math.max(1, remaining),
      );
      timer.unref();
      this._register({ dispose: () => clearTimeout(timer) });
    }
  }

  get active(): boolean {
    return this.options !== undefined;
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get readOnly(): boolean {
    return this.options?.readOnly ?? false;
  }

  snapshot(): HeadlessState {
    return {
      usage: {
        ...this.usage,
        elapsedMs: this.usage.elapsedMs + Date.now() - this.startedAt,
        recentDenials: [...this.usage.recentDenials],
      },
      reason: this.reason,
      denial: this.denial,
    };
  }

  stop(reason: string): void {
    if (!this.active || this.reason !== undefined) return;
    this.reason = reason;
    this.controller.abort(new Error('AutoKimi run stopped: ' + reason));
    this.publish();
  }

  check(): void {
    if (!this.active) return;
    if (this.snapshot().usage.elapsedMs >= this.options!.limits.timeoutMs)
      this.stop('timeout');
    if (this.usage.tokens >= this.options!.limits.maxTokens)
      this.stop('token_budget');
    if (this.reason !== undefined)
      throw new Error('AutoKimi run stopped: ' + this.reason);
  }

  beforeStep(): void {
    if (!this.active) return;
    this.check();
    if (this.usage.steps >= this.options!.limits.maxSteps)
      this.stop('step_budget');
    this.check();
    this.usage.steps += 1;
    this.publish();
  }

  beforeTool(): void {
    if (!this.active) return;
    this.check();
    if (this.usage.tools >= this.options!.limits.maxTools)
      this.stop('tool_budget');
    this.check();
    this.usage.tools += 1;
    this.publish();
  }

  toolPolicy(context: ResolvedToolExecutionHookContext): string | undefined {
    if (!this.active) return undefined;
    this.beforeTool();
    const name = context.toolCall.name;
    const blocked = (reason: string): string => {
      this.reportDenial(context.toolCall.id, name, reason);
      return reason;
    };
    if (['CreateGoal', 'CronCreate', 'CronUpdate'].includes(name))
      return blocked('Headless autonomous scheduling is owned by the caller.');
    if (
      ['Bash', 'Agent', 'AgentSwarm', 'AskUserQuestion'].includes(name) &&
      typeof context.args === 'object' &&
      context.args !== null
    ) {
      const args = context.args as {
        run_in_background?: unknown;
        background?: unknown;
      };
      if (args.run_in_background === true || args.background === true)
        return blocked(
          'Headless background delegation must be managed by the caller.',
        );
    }
    if (this.readOnly && !HEADLESS_SAFE_TOOLS.has(name))
      return blocked(
        'Headless read-only capability does not permit this tool.',
      );
    if (
      !this.options!.allowNetwork &&
      (name === 'WebSearch' || name === 'FetchURL' || name.startsWith('mcp__'))
    )
      return blocked('Headless network tool capability was not granted.');
    const inside = (path: string, root = this.options!.workDir): boolean => {
      const fromRoot = relative(root, path);
      return (
        !isAbsolute(fromRoot) &&
        fromRoot !== '..' &&
        !fromRoot.startsWith('../')
      );
    };
    const canonical = (path: string): string => {
      let current = resolve(this.options!.workDir, path);
      const suffix: string[] = [];
      const seen = new Set<string>();
      for (;;) {
        if (seen.has(current))
          throw new Error('Cannot resolve headless access path');
        seen.add(current);
        try {
          return resolve(realpathSync(current), ...suffix);
        } catch {
          try {
            current = resolve(dirname(current), readlinkSync(current));
            continue;
          } catch {}
          const parent = dirname(current);
          if (parent === current) return current;
          suffix.unshift(current.slice(parent.length + 1));
          current = parent;
        }
      }
    };
    try {
      for (const access of context.execution.accesses ?? []) {
        if (access.kind !== 'file') continue;
        const path = canonical(access.path);
        if (!inside(path))
          return blocked(
            'Headless file access is outside the granted workspace.',
          );
        if (
          this.options!.protectedDirs?.some((directory) =>
            inside(path, canonical(directory)),
          )
        )
          return blocked(
            'Headless file access targets protected runtime storage.',
          );
      }
      if (
        name === 'Bash' &&
        typeof context.args === 'object' &&
        context.args !== null
      ) {
        const cwd = (context.args as { cwd?: unknown }).cwd;
        if (typeof cwd === 'string' && !inside(canonical(cwd)))
          return blocked(
            'Headless shell cwd is outside the granted workspace.',
          );
      }
    } catch {
      return blocked('Headless file access could not be resolved safely.');
    }
    return undefined;
  }

  beginRequest(): void {
    if (!this.active) return;
    this.check();
    if (this.usage.requests >= this.options!.limits.maxRequests)
      this.stop('request_budget');
    this.check();
    this.usage.requests += 1;
    this.publish();
  }

  async *observe(
    events: AsyncIterable<ModelRequestEvent>,
  ): AsyncIterable<ModelRequestEvent> {
    let recorded = 0;
    for await (const event of events) {
      if (this.active && event.type === 'usage') {
        const values = [
          event.usage.inputOther,
          event.usage.inputCacheRead,
          event.usage.inputCacheCreation,
          event.usage.output,
        ];
        if (values.some((value) => !Number.isFinite(value) || value < 0)) {
          this.stop('invalid_usage');
          this.check();
        }
        const total = values.reduce((sum, value) => sum + value, 0);
        this.usage.tokens += Math.max(0, total - recorded);
        recorded = Math.max(recorded, total);
        this.publish();
        this.check();
      }
      yield event;
    }
  }

  reportDenial(toolCallId: string, tool: string, reason: string): void {
    if (!this.active) return;
    this.usage.denials += 1;
    this.denial = { toolCallId, tool, reason: reason.slice(0, 240) };
    this.publish();
  }

  review(safetyDenial: boolean, allowed: boolean): void {
    if (!this.active) return;
    this.usage.consecutiveDenials = safetyDenial
      ? this.usage.consecutiveDenials + 1
      : 0;
    this.usage.recentDenials = [
      ...this.usage.recentDenials.slice(-49),
      safetyDenial,
    ];
    if (
      this.usage.consecutiveDenials >= 3 ||
      this.usage.recentDenials.filter(Boolean).length >= 10
    )
      this.stop('safety_denied');
    else this.publish();
    if (!allowed) return;
    this.check();
  }

  private publish(): void {
    try {
      this.options?.onUpdate(this.snapshot());
    } catch (error) {
      this.reason = 'persistence_failed';
      this.controller.abort(error);
      throw error;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IAutoKimiHeadless,
  AutoKimiHeadlessControl,
  ScopeActivation.OnDemand,
);
