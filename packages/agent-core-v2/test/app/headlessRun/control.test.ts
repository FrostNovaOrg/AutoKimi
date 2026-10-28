import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HeadlessRunControl,
  type HeadlessOptions,
} from '#/app/headlessRun/control';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { ModelRequestEvent } from '#/llm-adapter/model/model-requester';

const roots: string[] = [];
const controls: HeadlessRunControl[] = [];
function options(): HeadlessOptions {
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-capability-'));
  roots.push(workDir);
  return {
    limits: {
      maxSteps: 2,
      maxRequests: 4,
      maxTools: 4,
      maxTokens: 100,
      timeoutMs: 60000,
    },
    initial: {
      steps: 0,
      requests: 0,
      tools: 0,
      tokens: 0,
      elapsedMs: 0,
      denials: 0,
      consecutiveDenials: 0,
      recentDenials: [],
    },
    workDir,
    readOnly: false,
    allowNetwork: false,
    onUpdate: vi.fn(),
  };
}
function control(value = options()): HeadlessRunControl {
  const result = new HeadlessRunControl(value);
  controls.push(result);
  return result;
}
function context(
  name: string,
  path?: string,
): ResolvedToolExecutionHookContext {
  return {
    toolCall: { name },
    args: {},
    execution: {
      accesses:
        path === undefined ? [] : [{ kind: 'file', operation: 'read', path }],
    },
  } as unknown as ResolvedToolExecutionHookContext;
}
async function* usage(...counts: number[]): AsyncIterable<ModelRequestEvent> {
  for (const count of counts)
    yield {
      type: 'usage',
      usage: {
        inputOther: count,
        inputCacheCreation: 0,
        inputCacheRead: 0,
        output: 1,
      },
    };
}
async function consume(value: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of value) {
  }
}

afterEach(() => {
  for (const value of controls.splice(0)) value.dispose();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('host-owned headless envelope', () => {
  it('leaves ordinary runtimes unbounded', () => {
    const value = new HeadlessRunControl();
    controls.push(value);
    for (let i = 0; i < 200; i++) {
      value.beforeStep();
      value.beginRequest();
      value.beforeTool();
    }
    expect(value.active).toBe(false);
    expect(value.signal.aborted).toBe(false);
  });
  it('stops before another step and cannot be widened by mutating the caller object', () => {
    const settings = options();
    const value = control(settings);
    (settings.limits as { maxSteps: number }).maxSteps = 100;
    value.beforeStep();
    value.beforeStep();
    expect(() => value.beforeStep()).toThrow('step_budget');
    expect(value.snapshot().usage.steps).toBe(2);
    expect(value.signal.aborted).toBe(true);
  });
  it('inherits request usage across restarts and bounds retries/reviews before calls start', () => {
    const settings = options();
    settings.initial.requests = 3;
    const value = control(settings);
    value.beginRequest();
    expect(() => value.beginRequest()).toThrow('request_budget');
    expect(value.snapshot().usage.requests).toBe(4);
  });
  it('counts cumulative usage once per request and combines independent requests', async () => {
    const value = control();
    value.beginRequest();
    await consume(value.observe(usage(10, 10, 12)));
    value.beginRequest();
    await consume(value.observe(usage(7)));
    expect(value.snapshot().usage.tokens).toBe(21);
    expect(value.snapshot().usage.requests).toBe(2);
  });
  it('counts cached inputs and stops when reported total tokens reach the cap', async () => {
    const value = control();
    async function* events(): AsyncIterable<ModelRequestEvent> {
      yield {
        type: 'usage',
        usage: {
          inputOther: 10,
          inputCacheRead: 80,
          inputCacheCreation: 5,
          output: 5,
        },
      };
    }
    await expect(consume(value.observe(events()))).rejects.toThrow(
      'token_budget',
    );
    expect(value.snapshot().usage.tokens).toBe(100);
  });
  it('stops on inherited active-time exhaustion and operator cancellation', () => {
    vi.useFakeTimers();
    const settings = options();
    settings.initial.elapsedMs = 59990;
    const value = control(settings);
    vi.advanceTimersByTime(10);
    expect(value.snapshot().reason).toBe('timeout');
    const abort = new AbortController();
    const other = control({ ...options(), signal: abort.signal });
    abort.abort({ code: 'cancelled' });
    expect(other.snapshot().reason).toBe('cancelled');
  });
  it('fails closed when the durable usage writer fails', () => {
    const value = control({
      ...options(),
      onUpdate: () => {
        throw new Error('disk full');
      },
    });
    expect(() => value.beginRequest()).toThrow('disk full');
    expect(value.signal.aborted).toBe(true);
    expect(value.snapshot().reason).toBe('persistence_failed');
  });
  it('preserves safety-denial accounting across resumed runs', () => {
    const settings = options();
    settings.initial.consecutiveDenials = 2;
    settings.initial.recentDenials = [true, true];
    const value = control(settings);
    value.review(true, false);
    expect(value.snapshot().reason).toBe('safety_denied');
  });
  it('checks workspace capabilities before any native allow rule', () => {
    const settings = options();
    const value = control(settings);
    expect(
      value.toolPolicy(context('Read', join(settings.workDir, 'code.ts'))),
    ).toBeUndefined();
    expect(
      value.toolPolicy(
        context('Read', join(settings.workDir, '..', 'outside.txt')),
      ),
    ).toContain('outside');
    expect(value.toolPolicy(context('WebSearch'))).toContain('network');
  });
  it('allows goal bookkeeping in read-only runs while preserving caller limits and blocking cron scheduling', () => {
    const settings = { ...options(), readOnly: true };
    const value = control(settings);
    for (const tool of ['CreateGoal', 'SetGoalBudget', 'UpdateGoal'])
      expect(value.toolPolicy(context(tool))).toBeUndefined();
    expect(value.toolPolicy(context('CronCreate'))).toContain('caller');
    value.beforeStep();
    value.beforeStep();
    expect(() => value.beforeStep()).toThrow('step_budget');
    expect(value.snapshot().usage.steps).toBe(2);
  });
  it('rejects an existing symlink escaping the workspace', () => {
    const settings = options();
    const other = options().workDir;
    mkdirSync(join(other, 'private'));
    symlinkSync(join(other, 'private'), join(settings.workDir, 'alias'));
    expect(
      control(settings).toolPolicy(
        context('Write', join(settings.workDir, 'alias', 'new.txt')),
      ),
    ).toContain('outside');
  });
  it('protects runtime storage even when the workspace contains it', () => {
    const settings = options();
    const privateDir = join(settings.workDir, 'private-runtime');
    mkdirSync(privateDir);
    const value = control({ ...settings, protectedDirs: [privateDir] });
    expect(
      value.toolPolicy(context('Read', join(privateDir, 'config.toml'))),
    ).toContain('protected');
  });
  it('enforces read-only and tool budgets before dispatch', () => {
    const settings = options();
    const value = control({ ...settings, readOnly: true });
    expect(value.toolPolicy(context('Bash'))).toContain('read-only');
    value.beforeTool();
    value.beforeTool();
    value.beforeTool();
    expect(() => value.beforeTool()).toThrow('tool_budget');
  });
});
