import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  atomicJson,
  digest,
  RunStore,
  type RunRequest,
} from '#/cli/headless/store';

const roots: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'kimi-run-store-'));
  roots.push(home);
  const store = new RunStore(home, randomUUID());
  const request: RunRequest = {
    version: 1,
    run_id: store.id,
    prompt: 'Inspect synthetic source',
    work_dir: home,
    limits: {
      maxSteps: 3,
      maxRequests: 10,
      maxTools: 10,
      maxTokens: 1000,
      timeoutMs: 60000,
    },
    read_only: true,
    allow_network: false,
  };
  return { home, store, request };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('durable run protocol', () => {
  it('does not create storage while listing or querying missing tasks', () => {
    const { home } = fixture();
    const missingHome = join(home, 'missing-home');
    expect(RunStore.list(missingHome)).toEqual({ runs: [], warnings: [] });
    const missing = new RunStore(missingHome, randomUUID());
    expect(() => missing.readState()).toThrow('No task found');
    expect(existsSync(missingHome)).toBe(false);
    expect(() => new RunStore(home, randomUUID()).readState()).toThrow('No task found');
    expect(existsSync(join(home, 'runs'))).toBe(false);
    expect(RunStore.list(home)).toEqual({ runs: [], warnings: [] });
  });

  it('keeps valid tasks visible while reporting incomplete, corrupt and unsafe records', () => {
    const { home, store, request } = fixture();
    const healthy = store.create(request);
    const invalid = ['missing', 'json', 'shape', 'symlink'].map((kind) => ({ kind, store: new RunStore(home, randomUUID()) }));
    for (const entry of invalid) {
      mkdirSync(entry.store.directory, { mode: 0o700 });
      if (entry.kind === 'json') writeFileSync(entry.store.path('state.json'), '{broken', { mode: 0o600 });
      if (entry.kind === 'shape') atomicJson(entry.store.path('state.json'), {});
      if (entry.kind === 'symlink') symlinkSync(store.path('state.json'), entry.store.path('state.json'));
    }
    const result = RunStore.list(home);
    expect(result.runs).toEqual([healthy]);
    expect(result.warnings).toHaveLength(4);
    expect(new Set(result.warnings.map((warning) => warning.run_id))).toEqual(new Set(invalid.map((entry) => entry.store.id)));
    expect(result.warnings.every((warning) => warning.message.length > 0)).toBe(true);
    expect(result.warnings.find((warning) => warning.run_id === invalid[0]!.store.id)?.code).toBe('invalid_run_state');
    expect(JSON.parse(readFileSync(store.path('state.json'), 'utf8'))).toEqual(healthy);
  });

  it('refuses a hardlinked event journal without changing the other file', () => {
    const { home, store, request } = fixture();
    const state = store.create(request);
    const target = join(home, 'unrelated.json');
    atomicJson(target, { untouched: true });
    rmSync(store.path('events.jsonl'));
    linkSync(target, store.path('events.jsonl'));
    expect(() => store.event(state, 'run.usage', {})).toThrow(
      'private regular',
    );
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({
      untouched: true,
    });
  });

  it('canonicalizes idempotency fingerprints independently of option ordering', () => {
    expect(digest({ cwd: 'workspace', limits: { steps: 2, tokens: 9 } })).toBe(
      digest({ limits: { tokens: 9, steps: 2 }, cwd: 'workspace' }),
    );
  });
  it('allows an existing software directory while keeping run data private', () => {
    const home = mkdtempSync(join(tmpdir(), 'kimi-public-parent-'));
    roots.push(home);
    expect(lstatSync(home).isDirectory()).toBe(true);
    const { request } = fixture();
    const store = new RunStore(home, randomUUID());
    store.create({ ...request, run_id: store.id, work_dir: home });
    expect(lstatSync(store.root).mode & 0o777).toBe(0o700);
  });
  it('keeps task inputs private and paginates events with an exclusive cursor', () => {
    const { store, request } = fixture();
    let state = store.create(request);
    state = store.event(state, 'run.started', {});
    store.event(state, 'run.finished', { reason: 'completed' });
    const first = store.events(0, 2);
    expect(first.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBe(2);
    expect(store.events(2).events.map((event) => event.sequence)).toEqual([3]);
    expect(lstatSync(store.path('request.json')).mode & 0o777).toBe(0o600);
    expect(lstatSync(store.directory).mode & 0o777).toBe(0o700);
  });
  it('recovers the journal tail after a torn write without repeating prior events', () => {
    const { store, request } = fixture();
    const original = store.create(request);
    const next = store.event(
      { ...original, usage: { ...original.usage, requests: 2 } },
      'run.usage',
      {},
    );
    atomicJson(store.path('state.json'), original);
    appendFileSync(store.path('events.jsonl'), '{"incomplete":');
    expect(store.recover().usage.requests).toBe(2);
    expect(store.state().sequence).toBe(next.sequence);
    expect(
      readFileSync(store.path('events.jsonl'), 'utf8').endsWith('\n'),
    ).toBe(true);
  });
  it('serializes submissions, worker ownership and native-session writers', () => {
    const { home, store, request } = fixture();
    store.create(request);
    const unlock = RunStore.submitLock(home);
    expect(() => RunStore.submitLock(home)).toThrow('submission');
    unlock();
    const release = store.claim();
    expect(() => store.claim()).toThrow('still cleaning up');
    release();
    const session = store.sessionLease('synthetic-session');
    expect(() => store.sessionLease('synthetic-session')).toThrow(
      'owns this session',
    );
    session();
  });
  it('rejects traversal IDs and symlinked state instead of following them', () => {
    const { home, store, request } = fixture();
    store.create(request);
    expect(() => new RunStore(home, '../outside')).toThrow('UUID');
    const target = join(home, 'outside.json');
    atomicJson(target, { untouched: true });
    rmSync(store.path('state.json'));
    symlinkSync(target, store.path('state.json'));
    expect(() => store.readState()).toThrow('regular file');
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({
      untouched: true,
    });
  });
  it('refuses state exposed to other users', () => {
    const { store, request } = fixture();
    store.create(request);
    chmodSync(store.path('request.json'), 0o644);
    expect(() => store.request()).toThrow('private');
  });
});
