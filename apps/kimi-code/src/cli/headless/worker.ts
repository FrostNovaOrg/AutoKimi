import { existsSync } from 'node:fs';
import {
  createKimiHarness,
  type Session,
  type Event,
  type HeadlessState,
  type GoalUpdatedEvent,
} from '@moonshot-ai/kimi-code-sdk';
import { createKimiCodeHostIdentity } from '../version';
import { privateJson, RunError, RunStore } from './store';

function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new RunError(
              'cleanup_timeout',
              'The runtime did not settle during cleanup.',
            ),
          ),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer!));
}

export async function runWorker(
  store: RunStore,
  version: string,
  home: string,
): Promise<void> {
  const release = store.claim();
  let state = store.state();
  const initialElapsed = state.usage.elapsedMs;
  const startedAt = Date.now();
  let session: Session | undefined;
  let releaseSession: (() => void) | undefined;
  let harness: ReturnType<typeof createKimiHarness> | undefined;
  const abort = new AbortController();
  let stopReason: string | undefined;
  const inheritedTasks = new Set<string>();
  let finishStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  const running = <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([
      promise,
      stopped.then(() => {
        throw new RunError(
          stopReason ?? 'cancelled',
          'Run stopped during startup.',
        );
      }),
    ]);
  const emit = (type: string, data: unknown = {}) => {
    state = store.event(state, type, data);
  };
  const update = (value: HeadlessState) => {
    const previousDenials = state.usage.denials;
    state = {
      ...state,
      usage: {
        ...value.usage,
        elapsedMs: Math.max(
          value.usage.elapsedMs,
          initialElapsed + Date.now() - startedAt,
        ),
      },
    };
    if (value.usage.denials > previousDenials && value.denial !== undefined) {
      const denial = {
        tool_call_id: value.denial.toolCallId,
        tool: value.denial.tool,
        reason: value.denial.reason,
      };
      state = {
        ...state,
        permission_denials: [
          ...(state.permission_denials ?? []).slice(-99),
          denial,
        ],
      };
      emit('permission.denied', denial);
    }
    if (value.reason !== undefined) {
      stopReason ??= value.reason;
      state = { ...state, status: 'stopping', reason: stopReason };
      finishStop();
    }
    emit('run.usage', { usage: value.usage, reason: value.reason });
  };
  const stop = (reason: string) => {
    stopReason ??= reason;
    if (!abort.signal.aborted) abort.abort(new RunError(reason, reason));
    finishStop();
  };
  const signalStop = () => stop('cancelled');
  process.on('SIGINT', signalStop);
  process.on('SIGTERM', signalStop);
  const checkCancellation = () => {
    if (
      existsSync(store.path('cancel.json')) &&
      privateJson<{ attempt: number }>(store.path('cancel.json')).attempt ===
        state.attempt
    )
      stop('cancelled');
  };
  const cancellation = setInterval(() => {
    try {
      checkCancellation();
    } catch {
      stop('persistence_failed');
    }
  }, 100);
  cancellation.unref();
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    const request = store.request();
    process.chdir(request.work_dir);
    checkCancellation();
    if (stopReason !== undefined)
      throw new RunError(stopReason, 'Run cancelled before model startup.');
    state = {
      ...state,
      status: 'running',
      reason: undefined,
      resumable: false,
      error: undefined,
      final_text: undefined,
      input: undefined,
    };
    emit('run.started', { resumed: request.session_id !== undefined });
    heartbeat = setInterval(() => {
      state = {
        ...state,
        usage: {
          ...state.usage,
          elapsedMs: initialElapsed + Date.now() - startedAt,
        },
      };
      try {
        emit('run.heartbeat', {});
      } catch {
        stop('persistence_failed');
      }
    }, 5000);
    heartbeat.unref();
    harness = createKimiHarness({
      homeDir: home,
      identity: createKimiCodeHostIdentity(version),
      headless: {
        limits: request.limits,
        initial: state.usage,
        workDir: request.work_dir,
        readOnly: request.read_only,
        allowNetwork: request.allow_network,
        signal: abort.signal,
        onUpdate: update,
      },
    });
    const features = await running(harness.getExperimentalFeatures());
    const feature = features.find((entry) => entry.id === 'approval_review');
    if (feature?.enabled !== true)
      throw new RunError(
        'review_disabled',
        'The approval_review capability is disabled; automatic review is required.',
      );
    if (request.session_id !== undefined)
      releaseSession = store.sessionLease(request.session_id);
    session =
      request.session_id === undefined
        ? await running(
            harness.createSession({
              workDir: request.work_dir,
              permission: 'review',
              model: request.model,
            }),
          )
        : await running(harness.resumeSession({ id: request.session_id }));
    if (session.workDir !== request.work_dir)
      throw new RunError(
        'workspace_changed',
        'The saved session belongs to a different workspace.',
      );
    if (releaseSession === undefined)
      releaseSession = store.sessionLease(session.id);
    state = { ...state, session_id: session.id };
    emit('session.created', {});
    for (const task of await running(
      session.listBackgroundTasks({ activeOnly: true }),
    ))
      inheritedTasks.add(task.taskId);
    await running(session.setPermission('review'));
    if (request.model !== undefined)
      await running(session.setModel(request.model));
    const status = await running(session.getStatus());
    if (!status.model || status.permission !== 'review')
      throw new RunError(
        'model_not_configured',
        'A configured model and Auto Review permission mode are required.',
      );
    state = { ...state, session_id: session.id };
    emit('session.ready', {
      model: status.model,
      permission: status.permission,
    });
    session.setApprovalHandler(() => {
      stop('approval_unavailable');
      return { decision: 'rejected' };
    });
    session.setQuestionHandler((question) => {
      state = { ...state, input: question };
      emit('run.input_required', question);
      stop('blocked_input');
      return { status: 'cancelled' };
    });
    let ended = false;
    let ending: string | undefined;
    let lastActivity = Date.now();
    const activeTurns = new Set<string>();
    let pendingText = '';
    let textEmittedAt = 0;
    const flushText = () => {
      if (pendingText.length === 0) return;
      emit('assistant.delta', {
        text: pendingText.slice(0, 8192),
        truncated: pendingText.length > 8192,
      });
      pendingText = '';
      textEmittedAt = Date.now();
    };
    session.onEvent((event: Event) => {
      const value = event as unknown as {
        agentId?: string;
        turnId?: number;
        reason?: string;
        text?: string;
        delta?: string;
        toolCallId?: string;
        name?: string;
        isError?: boolean;
        code?: string;
        message?: string;
        update?: { message?: string };
      };
      lastActivity = Date.now();
      if (event.type !== 'assistant.delta') flushText();
      const key = String(value.agentId) + ':' + String(value.turnId);
      if (event.type === 'turn.started') activeTurns.add(key);
      if (event.type === 'turn.ended') {
        activeTurns.delete(key);
        if (value.agentId === 'main') {
          ended = true;
          ending = value.reason;
        }
        emit('turn.ended', {
          agent_id: value.agentId,
          turn_id: value.turnId,
          reason: value.reason,
        });
      } else if (
        event.type === 'turn.step.started' &&
        value.agentId === 'main'
      ) {
        state = { ...state, final_text: '', text_truncated: false };
        emit('step.started', { agent_id: value.agentId });
      } else if (event.type === 'assistant.delta' && value.agentId === 'main') {
        const text =
          typeof value.text === 'string'
            ? value.text
            : typeof value.delta === 'string'
              ? value.delta
              : '';
        const combined = (state.final_text ?? '') + text;
        state = {
          ...state,
          final_text: combined.slice(0, 65536),
          text_truncated: combined.length > 65536 || state.text_truncated,
        };
        pendingText += text;
        if (pendingText.length >= 256 || Date.now() - textEmittedAt >= 100)
          flushText();
      } else if (event.type === 'goal.updated') {
        const goal = event as GoalUpdatedEvent;
        state = {
          ...state,
          goal:
            goal.snapshot ??
            (state.goal?.status === 'complete' ? state.goal : null),
        };
        emit('goal.updated', { goal: state.goal, change: goal.change });
      } else if (event.type === 'tool.call.started') {
        const tool = {
          id: String(value.toolCallId),
          name: String(value.name),
          agent_id: value.agentId,
        };
        state = {
          ...state,
          active_tools: [
            ...(state.active_tools ?? []).filter(
              (entry) => entry.id !== tool.id,
            ),
            tool,
          ],
        };
        emit('tool.started', tool);
      } else if (event.type === 'tool.result') {
        state = {
          ...state,
          active_tools: state.active_tools?.filter(
            (entry) => entry.id !== value.toolCallId,
          ),
        };
        emit('tool.result', {
          tool_call_id: value.toolCallId,
          is_error: value.isError,
        });
      } else if (event.type === 'tool.progress') {
        emit('tool.progress', {
          tool_call_id: value.toolCallId,
          message: value.update?.message?.slice(0, 2048),
        });
      } else if (event.type === 'error') {
        emit('runtime.error', {
          code: value.code,
          message: String(value.message ?? 'Runtime error').slice(0, 2048),
        });
      }
    });
    const restoredGoal = (await running(session.getGoal())).goal;
    if (
      state.attempt > 1 &&
      (restoredGoal?.status === 'paused' || restoredGoal?.status === 'blocked')
    )
      await running(session.resumeGoal());
    await running(
      session.prompt(request.prompt, {
        promptId: store.id + ':' + state.attempt,
      }),
    );
    const wait = async () => {
      while (stopReason === undefined) {
        if (
          ended &&
          activeTurns.size === 0 &&
          Date.now() - lastActivity > 200
        ) {
          const { goal } = await session!.getGoal();
          if (goal?.status === 'active') {
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
            continue;
          }
          if (goal?.status === 'blocked' || goal?.status === 'paused') {
            stopReason = `goal_${goal.status}`;
            return;
          }
          const tasks = await session!.listBackgroundTasks({
            activeOnly: true,
          });
          if (tasks.every((task) => inheritedTasks.has(task.taskId))) return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    };
    await Promise.race([wait(), stopped]);
    if (stopReason === undefined && ending !== 'completed')
      stopReason =
        ending === 'cancelled'
          ? 'cancelled'
          : ending === 'blocked'
            ? 'blocked_input'
            : 'runtime_failed';
  } catch (error) {
    stopReason ??= error instanceof RunError ? error.code : 'runtime_failed';
    state = {
      ...state,
      error: {
        code: stopReason,
        message:
          error instanceof Error
            ? error.message.slice(0, 2048)
            : 'Runtime failure',
      },
    };
  } finally {
    clearInterval(cancellation);
    if (heartbeat !== undefined) clearInterval(heartbeat);
    try {
      if (session !== undefined) {
        await bounded(session.cancel(), 8000);
        const tasks = (
          await session.listBackgroundTasks({ activeOnly: true })
        ).filter((task) => !inheritedTasks.has(task.taskId));
        await bounded(
          Promise.all(
            tasks.map((task) => session!.stopBackgroundTask(task.taskId)),
          ),
          8000,
        );
      }
      if (harness !== undefined) await bounded(harness.close(), 8000);
    } catch (error) {
      stopReason = 'cleanup_failed';
      state = {
        ...state,
        error: {
          code: stopReason,
          message: error instanceof Error ? error.message : 'Cleanup failed',
        },
      };
    }
    const resumable =
      (state.session_id !== undefined || state.usage.requests === 0) &&
      [
        'step_budget',
        'request_budget',
        'tool_budget',
        'token_budget',
        'timeout',
        'cancelled',
        'blocked_input',
        'goal_blocked',
        'goal_paused',
      ].includes(stopReason ?? '');
    state = {
      ...state,
      usage: {
        ...state.usage,
        elapsedMs: initialElapsed + Date.now() - startedAt,
      },
      status:
        stopReason === undefined
          ? state.usage.denials > 0
            ? 'completed_with_denials'
            : 'completed'
          : stopReason === 'blocked_input'
            ? 'blocked_input'
            : resumable || stopReason === 'safety_denied'
              ? 'stopped'
              : 'failed',
      reason:
        stopReason ??
        (state.usage.denials > 0 ? 'permission_denied' : 'completed'),
      resumable,
      active_tools: stopReason === 'cleanup_failed' ? state.active_tools : [],
    };
    try {
      emit('run.finished', {
        status: state.status,
        reason: state.reason,
        resumable,
        final_text: state.final_text,
        goal: state.goal,
        text_truncated: state.text_truncated,
        usage: state.usage,
        limits: state.limits,
        permission_denials: state.permission_denials,
        input: state.input,
        error: state.error,
      });
    } finally {
      process.off('SIGINT', signalStop);
      process.off('SIGTERM', signalStop);
      releaseSession?.();
      release();
    }
  }
}
