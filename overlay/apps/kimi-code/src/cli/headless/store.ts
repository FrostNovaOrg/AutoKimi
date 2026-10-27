import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { HeadlessLimits, HeadlessUsage } from '@moonshot-ai/kimi-code-sdk';

export class RunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface RunRequest {
  version: 1;
  run_id: string;
  prompt: string;
  work_dir: string;
  model?: string;
  limits: HeadlessLimits;
  read_only: boolean;
  allow_network: boolean;
  session_id?: string;
}

export interface RunState {
  version: 1;
  run_id: string;
  session_id?: string;
  status: string;
  reason?: string;
  resumable: boolean;
  attempt: number;
  sequence: number;
  created_at: string;
  updated_at: string;
  work_dir: string;
  limits: HeadlessLimits;
  usage: HeadlessUsage;
  active_tools?: Array<{ id: string; name: string; agent_id?: string }>;
  final_text?: string;
  text_truncated?: boolean;
  input?: unknown;
  permission_denials?: Array<{
    tool_call_id: string;
    tool: string;
    reason: string;
  }>;
  error?: { code: string; message: string };
}

export interface RunEvent {
  version: 1;
  run_id: string;
  session_id?: string;
  attempt: number;
  sequence: number;
  timestamp: string;
  type: string;
  data: unknown;
  state: RunState;
}

export const terminal = (state: RunState): boolean =>
  !['queued', 'running', 'stopping'].includes(state.status);
export const exitCode = (state: RunState): number =>
  state.status === 'completed'
    ? 0
    : ['blocked_input', 'completed_with_denials'].includes(state.status)
      ? 4
      : state.reason?.endsWith('_budget') || state.reason === 'timeout'
        ? 5
        : state.reason === 'cancelled'
          ? 6
          : 7;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const digest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export const emptyUsage = (): HeadlessUsage => ({
  steps: 0,
  requests: 0,
  tools: 0,
  tokens: 0,
  elapsedMs: 0,
  denials: 0,
  consecutiveDenials: 0,
  recentDenials: [],
});

function safeDirectory(path: string, privateMode = true): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (privateMode && (stat.mode & 0o077) !== 0))
    throw new RunError(
      'unsafe_store',
      'Run storage must be a private real directory: ' + path,
    );
}

function safeFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
    throw new RunError(
      'unsafe_store',
      'Run state must be a private regular file.',
    );
}

export function atomicJson(path: string, value: unknown): void {
  if (existsSync(path)) safeFile(path);
  const temporary = path + '.' + randomUUID() + '.tmp';
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function privateJson<T>(path: string): T {
  safeFile(path);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function claimPidFile(path: string, code: string, message: string): () => void {
  const temporary = path + '.' + randomUUID() + '.claim';
  atomicJson(temporary, { pid: process.pid });
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new RunError(code, message, true);
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
  return () => rmSync(path, { force: true });
}

export class RunStore {
  readonly root: string;
  readonly directory: string;

  constructor(
    home: string,
    readonly id: string,
  ) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new RunError('invalid_run_id', 'Expected a run UUID.');
    mkdirSync(home, { recursive: true });
    const base = join(realpathSync(home), 'autokimi');
    safeDirectory(base, false);
    this.root = join(base, 'runs');
    safeDirectory(this.root);
    this.directory = join(this.root, id);
  }

  path(name: string): string {
    return join(this.directory, name);
  }
  request(): RunRequest {
    return privateJson<RunRequest>(this.path('request.json'));
  }
  state(): RunState {
    return privateJson<RunState>(this.path('state.json'));
  }

  readState(): RunState {
    safeDirectory(this.directory);
    const state = this.state();
    const ownership = existsSync(this.path('owner.json'))
      ? this.path('owner.json')
      : this.path('launcher.json');
    if (!terminal(state) && existsSync(ownership)) {
      const owner = privateJson<{ pid: number }>(ownership);
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH')
          return {
            ...state,
            status: 'interrupted',
            reason: 'worker_lost',
            resumable: true,
          };
        throw error;
      }
    }
    return state;
  }

  create(request: RunRequest): RunState {
    mkdirSync(this.directory, { mode: 0o700 });
    atomicJson(this.path('request.json'), request);
    const now = new Date().toISOString();
    const state: RunState = {
      version: 1,
      run_id: this.id,
      session_id: request.session_id,
      status: 'queued',
      resumable: false,
      attempt: 1,
      sequence: 0,
      created_at: now,
      updated_at: now,
      work_dir: request.work_dir,
      limits: request.limits,
      usage: emptyUsage(),
    };
    atomicJson(this.path('state.json'), state);
    return this.event(state, 'run.queued', {});
  }

  event(state: RunState, type: string, data: unknown): RunState {
    state = {
      ...state,
      sequence: state.sequence + 1,
      updated_at: new Date().toISOString(),
    };
    const event: RunEvent = {
      version: 1,
      run_id: this.id,
      session_id: state.session_id,
      attempt: state.attempt,
      sequence: state.sequence,
      timestamp: state.updated_at,
      type,
      data,
      state:
        type === 'run.finished' ? state : { ...state, final_text: undefined },
    };
    const path = this.path('events.jsonl');
    if (existsSync(path)) {
      safeFile(path);
      if (lstatSync(path).size > 32 * 1024 * 1024)
        throw new RunError(
          'event_storage_limit',
          'Run event storage exceeded 32 MiB.',
        );
    }
    const fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_APPEND |
        constants.O_WRONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || file.nlink !== 1)
        throw new RunError('unsafe_store', 'Unsafe event journal');
      appendFileSync(fd, JSON.stringify(event) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    atomicJson(this.path('state.json'), state);
    return state;
  }

  events(
    after: number,
    limit = 100,
  ): { events: RunEvent[]; next_cursor: number; has_more: boolean } {
    const path = this.path('events.jsonl');
    safeFile(path);
    const lines = readFileSync(path, 'utf8').split('\n');
    const events: RunEvent[] = [];
    let hasMore = false;
    for (const line of lines.slice(0, -1)) {
      const event = JSON.parse(line) as RunEvent;
      if (event.sequence <= after) continue;
      if (events.length >= limit) {
        hasMore = true;
        break;
      }
      events.push(event);
    }
    return {
      events,
      next_cursor: events.at(-1)?.sequence ?? after,
      has_more: hasMore,
    };
  }

  recover(): RunState {
    const path = this.path('events.jsonl');
    safeFile(path);
    const text = readFileSync(path, 'utf8');
    const end = text.lastIndexOf('\n') + 1;
    if (end !== text.length)
      truncateSync(path, Buffer.byteLength(text.slice(0, end)));
    const last = text.slice(0, end).trimEnd().split('\n').at(-1);
    const state = last ? (JSON.parse(last) as RunEvent).state : this.state();
    atomicJson(this.path('state.json'), state);
    return state;
  }

  static submitLock(home: string): () => void {
    const root = new RunStore(home, randomUUID()).root;
    const path = join(root, 'submission.lock');
    if (existsSync(path)) {
      const owner = privateJson<{ pid: number }>(path);
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') rmSync(path);
        else throw error;
      }
    }
    return claimPidFile(
      path,
      'submission_busy',
      'Another submission is in progress; retry with the same idempotency key.',
    );
  }

  clearStaleOwner(): void {
    const path = this.path('owner.json');
    if (!existsSync(path)) return;
    const owner = privateJson<{ pid: number }>(path);
    try {
      process.kill(owner.pid, 0);
      throw new RunError(
        'run_busy',
        'The previous worker is still cleaning up.',
        true,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      rmSync(path);
      rmSync(this.path('control.json'), { force: true });
    }
  }

  claim(): () => void {
    safeDirectory(this.directory);
    this.clearStaleOwner();
    return claimPidFile(
      this.path('owner.json'),
      'run_busy',
      'This run already has an active worker.',
    );
  }

  sessionLease(sessionId: string): () => void {
    const path = join(this.root, 'session-' + digest(sessionId) + '.lock');
    if (existsSync(path)) {
      const owner = privateJson<{ pid: number }>(path);
      try {
        process.kill(owner.pid, 0);
        throw new RunError(
          'session_busy',
          'Another headless run owns this session.',
          true,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        rmSync(path);
      }
    }
    return claimPidFile(
      path,
      'session_busy',
      'Another headless run owns this session.',
    );
  }

  static list(home: string): RunState[] {
    const root = new RunStore(home, randomUUID()).root;
    return readdirSync(root)
      .filter((name) => /^[a-f0-9-]{36}$/.test(name))
      .map((name) => new RunStore(home, name).readState())
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
}
