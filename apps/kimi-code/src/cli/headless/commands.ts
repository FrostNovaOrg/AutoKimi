import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Command, Option } from 'commander';
import {
  resolveKimiHome,
  type HeadlessLimits,
} from '@moonshot-ai/kimi-code-sdk';
import { finalizeHeadlessRun } from '../headless-exit';
import { detectNativeInstall } from '../update/source';
import {
  atomicJson,
  digest,
  exitCode,
  privateJson,
  RunError,
  RunStore,
  terminal,
  type RunRequest,
  type RunState,
} from './store';
import { runWorker } from './worker';

interface ExecOptions {
  prompt?: unknown;
  promptFile?: unknown;
  cwd?: unknown;
  session?: unknown;
  resume?: unknown;
  idempotencyKey?: unknown;
  maxSteps?: unknown;
  maxRequests?: unknown;
  maxTools?: unknown;
  maxTokens?: unknown;
  timeout?: unknown;
  model?: unknown;
  readOnly?: unknown;
  allowNetwork?: unknown;
  detach?: unknown;
  format?: unknown;
  worker?: unknown;
  acceptUncertainEffects?: unknown;
}

const defaults: HeadlessLimits = {
  maxSteps: 30,
  maxRequests: 120,
  maxTools: 100,
  maxTokens: 200000,
  timeoutMs: 900000,
};
const json = (value: unknown) => {
  process.stdout.write(JSON.stringify(value) + '\n');
};

function integer(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0 || result > 0x7fffffff)
    throw new RunError(
      'invalid_budget',
      'Budgets must be positive integers no larger than 2147483647.',
    );
  return result;
}

function stringOption(value: unknown): string {
  if (typeof value !== 'string') throw new RunError('invalid_input', 'Expected a string option.');
  return value;
}

function timeout(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(stringOption(value));
  if (match === null)
    throw new RunError(
      'invalid_timeout',
      'Use an integer followed by ms, s, m, or h.',
    );
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
  };
  return integer(Number(match[1]) * units[match[2] ?? 'ms']!, fallback);
}

function limits(options: ExecOptions, previous = defaults): HeadlessLimits {
  return {
    maxSteps: integer(options.maxSteps, previous.maxSteps),
    maxRequests: integer(options.maxRequests, previous.maxRequests),
    maxTools: integer(options.maxTools, previous.maxTools),
    maxTokens: integer(options.maxTokens, previous.maxTokens),
    timeoutMs: timeout(options.timeout, previous.timeoutMs),
  };
}

function publicEvent(event: Record<string, unknown>): unknown {
  const { state: _state, ...rest } = event;
  return rest;
}

async function follow(store: RunStore, attempt: number): Promise<void> {
  let cursor = 0;
  for (;;) {
    const page = store.events(cursor);
    for (const event of page.events) {
      if (event.attempt !== attempt) continue;
      const line =
        JSON.stringify(
          publicEvent(event as unknown as Record<string, unknown>),
        ) + '\n';
      if (!process.stdout.write(line))
        await new Promise<void>((resolve) =>
          process.stdout.once('drain', resolve),
        );
      if (event.type === 'run.finished') {
        process.exitCode = exitCode(event.state);
        return;
      }
    }
    cursor = page.next_cursor;
    const state = store.readState();
    if (state.attempt !== attempt)
      throw new RunError(
        'attempt_superseded',
        'A newer attempt owns this run; query its current state.',
      );
    if (terminal(state) && !page.has_more && cursor >= state.sequence) {
      if (state.reason === 'worker_lost')
        json({ version: 1, type: 'run.interrupted', state });
      process.exitCode = exitCode(state);
      return;
    }
    await delay(100);
  }
}

async function stopRun(store: RunStore): Promise<void> {
  const state = store.readState();
  if (terminal(state)) {
    json({ version: 1, type: 'run.snapshot', state });
    return;
  }
  atomicJson(store.path('cancel.json'), { attempt: state.attempt });
  json({
    version: 1,
    type: 'run.stop_accepted',
    run_id: store.id,
    attempt: state.attempt,
  });
}

async function submit(options: ExecOptions): Promise<void> {
  const home = resolveKimiHome();
  let prompt: string | undefined;
  if (options.prompt !== undefined && options.promptFile !== undefined)
    throw new RunError('invalid_input', 'Choose --prompt or --prompt-file.');
  if (options.prompt !== undefined) prompt = stringOption(options.prompt);
  if (options.promptFile !== undefined) {
    const path = resolve(stringOption(options.promptFile));
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new RunError(
        'invalid_input',
        'Prompt files must be regular files no larger than 1 MiB.',
      );
    prompt = readFileSync(path, 'utf8');
  }
  if (
    prompt !== undefined &&
    (Buffer.byteLength(prompt) > 1024 * 1024 ||
      prompt.trim().length === 0 ||
      prompt.trimStart().startsWith('KIMI_REVIEW_GRANT_V1'))
  )
    throw new RunError(
      'invalid_input',
      'Provide a nonempty prompt up to 1 MiB without interactive approval markers.',
    );
  if (options.format !== undefined && options.format !== 'jsonl')
    throw new RunError('invalid_format', 'Headless output format is jsonl.');
  const key =
    options.idempotencyKey === undefined
      ? undefined
      : stringOption(options.idempotencyKey);
  if (key !== undefined && (key.length === 0 || key.length > 256))
    throw new RunError(
      'invalid_idempotency_key',
      'Idempotency keys must contain 1–256 characters.',
    );
  const resumeRequest =
    options.resume === undefined
      ? undefined
      : new RunStore(home, stringOption(options.resume)).request();
  const fingerprint = digest({
    prompt:
      prompt ??
      (resumeRequest === undefined
        ? undefined
        : 'Continue the existing task within its original authorization and remaining run budget.'),
    work_dir:
      options.cwd === undefined && resumeRequest !== undefined
        ? resumeRequest.work_dir
        : realpathSync(resolve(stringOption(options.cwd ?? process.cwd()))),
    resume: options.resume,
    session: options.session,
    model: options.model ?? resumeRequest?.model,
    limits: limits(options, resumeRequest?.limits),
    read_only: resumeRequest?.read_only === true || options.readOnly === true,
    allow_network:
      resumeRequest?.allow_network === true || options.allowNetwork === true,
  });
  const unlock = RunStore.submitLock(home);
  let store: RunStore;
  let state: RunState;
  let duplicate = false;
  try {
    const root = new RunStore(home, randomUUID()).root;
    const keyPath =
      key === undefined
        ? undefined
        : join(root, 'key-' + digest(key) + '.json');
    if (keyPath !== undefined && existsSync(keyPath)) {
      const existing = privateJson<{
        run_id: string;
        attempt: number;
        fingerprint: string;
      }>(keyPath);
      if (existing.fingerprint !== fingerprint)
        throw new RunError(
          'idempotency_conflict',
          'This key was already used with a different request.',
        );
      store = new RunStore(home, existing.run_id);
      state = store.readState();
      if (state.attempt !== existing.attempt)
        throw new RunError(
          'attempt_superseded',
          'The idempotent request belongs to an earlier attempt; query the run.',
        );
      duplicate = true;
    } else if (options.resume !== undefined) {
      if (options.session !== undefined)
        throw new RunError(
          'invalid_input',
          '--session and --resume are mutually exclusive.',
        );
      store = new RunStore(home, stringOption(options.resume));
      state = store.readState();
      if (!terminal(state))
        throw new RunError(
          'run_busy',
          'Run is active; query or attach to it instead.',
          true,
        );
      if (!state.resumable)
        throw new RunError(
          'not_resumable',
          'This stop reason does not permit unattended continuation.',
        );
      if (
        (state.active_tools?.length ?? 0) > 0 &&
        options.acceptUncertainEffects !== true
      )
        throw new RunError(
          'uncertain_effects',
          'Inspect the interrupted tool effects before resuming with --accept-uncertain-effects.',
        );
      const previous = store.request();
      if (
        options.cwd !== undefined &&
        realpathSync(resolve(stringOption(options.cwd))) !== previous.work_dir
      )
        throw new RunError(
          'workspace_changed',
          'Resume must use the original workspace.',
        );
      if (
        options.model !== undefined ||
        (options.allowNetwork === true && !previous.allow_network)
      )
        throw new RunError(
          'scope_changed',
          'Resume cannot change model or expand tool capabilities; start a new explicit task.',
        );
      const nextLimits = limits(options, previous.limits);
      if (
        state.usage.steps >= nextLimits.maxSteps ||
        state.usage.requests >= nextLimits.maxRequests ||
        state.usage.tools >= nextLimits.maxTools ||
        state.usage.tokens >= nextLimits.maxTokens ||
        state.usage.elapsedMs >= nextLimits.timeoutMs
      )
        throw new RunError(
          'budget_exhausted',
          'Increase the exhausted total budget explicitly before resuming.',
        );
      store.clearStaleOwner();
      const recovered = store.recover();
      state = {
        ...recovered,
        limits: nextLimits,
        status: 'queued',
        reason: undefined,
        resumable: false,
        attempt: state.attempt + 1,
      };
      const request = {
        ...previous,
        limits: nextLimits,
        read_only: previous.read_only || options.readOnly === true,
        prompt:
          prompt ??
          (state.session_id === undefined
            ? previous.prompt
            : 'Continue the existing task within its original authorization and remaining run budget.'),
        session_id: state.session_id,
      };
      atomicJson(store.path('request.json'), request);
      state = store.event(state, 'run.queued', { resumed: true });
      rmSync(store.path('launcher.json'), { force: true });
    } else {
      if (prompt === undefined)
        throw new RunError(
          'missing_prompt',
          'Provide --prompt or --prompt-file.',
        );
      const workDir = realpathSync(
        resolve(stringOption(options.cwd ?? process.cwd())),
      );
      store = new RunStore(home, randomUUID());
      const request: RunRequest = {
        version: 1,
        run_id: store.id,
        prompt,
        work_dir: workDir,
        session_id:
          options.session === undefined ? undefined : stringOption(options.session),
        model: options.model === undefined ? undefined : stringOption(options.model),
        limits: limits(options),
        read_only: options.readOnly === true,
        allow_network: options.allowNetwork === true,
      };
      state = store.create(request);
    }
    if (keyPath !== undefined && !duplicate)
      atomicJson(keyPath, {
        run_id: store.id,
        attempt: state.attempt,
        fingerprint,
      });
    if (!duplicate) {
      const child = spawn(
        process.execPath,
        [...(detectNativeInstall() ? [] : [resolve(process.argv[1]!)]), 'exec', '--worker', store.id],
        {
          detached: true,
          stdio: 'ignore',
          cwd: state.work_dir,
          env: {
            ...process.env,
            KIMI_CODE_HOME: home,
            KIMI_DISABLE_TELEMETRY: '1',
          },
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      atomicJson(store.path('launcher.json'), { pid: child.pid });
      child.unref();
    }
  } finally {
    unlock();
  }
  if (options.detach === true) {
    json({
      version: 1,
      type: 'run.accepted',
      run_id: store.id,
      session_id: state.session_id,
      status: state.status,
      attempt: state.attempt,
      deduplicated: duplicate,
    });
    if (terminal(state)) process.exitCode = exitCode(state);
    return;
  }
  const interrupted = () => {
    void stopRun(store).catch(() => {});
  };
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  try {
    await follow(store, state.attempt);
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
}

export function registerHeadlessCommands(
  program: Command,
  version: string,
): void {
  const handle = (action: () => Promise<void> | void) => async () => {
    try {
      const incompatible = Object.keys(program.opts()).filter(
        (key) => program.getOptionValueSource(key) === 'cli',
      );
      if (incompatible.length > 0)
        throw new RunError(
          'invalid_global_option',
          'Place task options after exec; global options do not apply to exec or runs: ' +
            incompatible.join(', '),
        );
      await action();
    } catch (error) {
      json({
        version: 1,
        type: 'error',
        error: {
          code: error instanceof RunError ? error.code : 'operation_failed',
          message: error instanceof Error ? error.message : String(error),
          retryable: error instanceof RunError && error.retryable,
        },
      });
      process.exitCode = error instanceof RunError && error.retryable ? 3 : 2;
    }
  };
  const exec = program
    .command('exec')
    .description(
      'Run an observable, budgeted task with automatic permission review.',
    )
    .option('--prompt <text>', 'Task input.')
    .option('--prompt-file <path>', 'Read task input from a UTF-8 file.')
    .option(
      '--cwd <path>',
      'Granted workspace; defaults to the current directory.',
    )
    .option('--session <id>', 'Start a new task in an existing native session.')
    .option(
      '--resume <run-id>',
      'Continue a stopped run with inherited cumulative budgets.',
    )
    .option(
      '--idempotency-key <key>',
      'Stable key for safe submission retries.',
    )
    .option(
      '--max-steps <number>',
      'Total main/subagent model-loop step limit.',
    )
    .option(
      '--max-requests <number>',
      'Total model request limit including review and retries.',
    )
    .option('--max-tools <number>', 'Total tool attempt limit.')
    .option(
      '--max-tokens <number>',
      'Reported total input/output token limit; one request may overshoot.',
    )
    .option(
      '--timeout <duration>',
      'Cumulative active runtime, for example 15m.',
    )
    .option('--model <alias>', 'Configured main model alias for a new task.')
    .option('--read-only', 'Permit only the headless read-only tool set.')
    .option(
      '--allow-network',
      'Permit network tools and MCP calls, still subject to review.',
    )
    .option(
      '--accept-uncertain-effects',
      'Acknowledge inspected effects of an interrupted tool.',
    )
    .option(
      '--detach',
      'Return the run ID immediately; worker continues independently.',
    )
    .option('--format <format>', 'Machine output format: jsonl.')
    .addOption(new Option('--worker <id>').hideHelp());
  exec.action(
    handle(async () => {
      const options = exec.opts<ExecOptions>();
      if (options.worker !== undefined) {
        try {
          await runWorker(
            new RunStore(resolveKimiHome(), stringOption(options.worker)),
            version,
            resolveKimiHome(),
          );
        } finally {
          await finalizeHeadlessRun(
            process,
            [process.stdout, process.stderr],
            () =>
              process.exitCode === undefined ? 0 : Number(process.exitCode),
          );
        }
      } else await submit(options);
    }),
  );
  const runs = program
    .command('runs')
    .description(
      'Query and control Kimi headless runs without starting an agent.',
    );
  runs
    .command('schema')
    .description('Print the versioned protocol, defaults and exit codes.')
    .action(
      handle(() =>
        json({
          version: 1,
          format: 'jsonl',
          defaults,
          scope: 'one local Kimi home',
          resume_budget:
            'cumulative totals across attempts; exhausted caps require explicit increases',
          event_cursor: 'exclusive monotonic sequence across attempts',
          permissions: {
            mode: 'review',
            review_required: true,
            os_sandbox: true,
            sandbox_scope: 'Bash and descendant processes',
            network_tools_default: false,
          },
          goals: {
            start: 'automatic in review mode',
            permission: 'review',
            budget: 'shared cumulative run limits across goal turns and attempts',
          },
          statuses: [
            'queued',
            'running',
            'stopping',
            'completed',
            'completed_with_denials',
            'stopped',
            'blocked_input',
            'failed',
            'interrupted',
          ],
          exit_codes: {
            completed: 0,
            invalid_request: 2,
            retryable_conflict: 3,
            blocked_input_or_denials: 4,
            stopped_goal: 4,
            budget: 5,
            cancelled: 6,
            failed: 7,
          },
        }),
      ),
    );
  runs
    .command('list')
    .action(
      handle(() => {
        const { runs, warnings } = RunStore.list(resolveKimiHome());
        json({ version: 1, runs, warnings: warnings.length > 0 ? warnings : undefined });
      }),
    );
  runs
    .command('status <id>')
    .option('--json', 'Structured output (always enabled).')
    .action(async (id: string) =>
      handle(() =>
        json({
          version: 1,
          type: 'run.snapshot',
          state: new RunStore(resolveKimiHome(), id).readState(),
        }),
      )(),
    );
  const events = runs
    .command('events <id>')
    .option('--after <sequence>', 'Exclusive event cursor.', '0')
    .option('--limit <number>', 'Page size, at most 200.', '100');
  events.action(async (id: string) =>
    handle(() => {
      const options = events.opts<{ after: string; limit: string }>();
      const after = Number(options.after);
      const limit = integer(options.limit, 100);
      if (!Number.isSafeInteger(after) || after < 0 || limit > 200)
        throw new RunError(
          'invalid_cursor',
          'Expected a nonnegative cursor and page size 1–200.',
        );
      const result = new RunStore(resolveKimiHome(), id).events(after, limit);
      json({
        version: 1,
        ...result,
        events: result.events.map((event) =>
          publicEvent(event as unknown as Record<string, unknown>),
        ),
      });
    })(),
  );
  runs
    .command('stop <id>')
    .action(async (id: string) =>
      handle(() => stopRun(new RunStore(resolveKimiHome(), id)))(),
    );
}
