import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface LegacyKimiSession {
  readonly id: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly title?: string;
}

function component(value: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    /[/\\\u0000-\u001F]/.test(value)
  )
    throw new Error('A session ID must be a single path component.');
}

async function safeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`Unsafe session directory: ${path}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function metadata(directory: string): Promise<Record<string, unknown>> {
  for (const file of ['state.json', 'session-meta/state.json']) {
    const path = join(directory, file);
    if (!(await exists(path))) continue;
    if (file.includes('/'))
      await safeDirectory(join(directory, 'session-meta'));
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)
        throw new Error('Unsafe session metadata.');
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Invalid session metadata.');
      return value as Record<string, unknown>;
    } finally {
      await handle.close();
    }
  }
  throw new Error('Session metadata was not found.');
}

export async function listLegacyKimiSessions(
  homeDir: string,
): Promise<readonly LegacyKimiSession[]> {
  const root = join(homeDir, 'sessions');
  if (!(await exists(root))) return [];
  await safeDirectory(root);
  const sessions: LegacyKimiSession[] = [];
  for (const workspace of await readdir(root, { withFileTypes: true })) {
    if (!workspace.isDirectory() || workspace.name.startsWith('.')) continue;
    const bucket = join(root, workspace.name);
    for (const entry of await readdir(bucket, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = join(bucket, entry.name);
      const data = await metadata(directory);
      if (
        data['id'] !== entry.name ||
        typeof data['cwd'] !== 'string' ||
        !isAbsolute(data['cwd'])
      )
        throw new Error(`Session ${entry.name} has no valid workspace path.`);
      sessions.push({
        id: entry.name,
        sessionDir: directory,
        workDir: data['cwd'],
        title: typeof data['title'] === 'string' ? data['title'] : undefined,
      });
    }
  }
  return sessions;
}

async function snapshot(directory: string): Promise<string> {
  const entries: unknown[] = [];
  async function walk(path: string): Promise<void> {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
    )
      throw new Error(
        `Session import refuses links and special files: ${path}`,
      );
    entries.push([
      relative(directory, path),
      info.dev,
      info.ino,
      info.size,
      info.mtimeMs,
      info.ctimeMs,
    ]);
    if (info.isDirectory())
      for (const name of (await readdir(path)).toSorted())
        await walk(join(path, name));
  }
  await walk(directory);
  return JSON.stringify(entries);
}

async function copySnapshot(source: string, target: string): Promise<void> {
  await mkdir(target, { mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name),
      to = join(target, entry.name);
    if (entry.isDirectory()) {
      await copySnapshot(from, to);
      continue;
    }
    const input = await open(
      from,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await input.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 256 * 1024 * 1024)
        throw new Error(
          'Session import requires regular files no larger than 256 MiB.',
        );
      const output = await open(to, 'wx', 0o600);
      try {
        await output.writeFile(await input.readFile());
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
  }
}

async function importLease(
  root: string,
  id: string,
): Promise<() => Promise<void>> {
  for (const directory of [
    join(root, 'locks'),
    join(root, 'locks', 'sessions'),
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await safeDirectory(directory);
  }
  const path = join(root, 'locks', 'sessions', `${id}.lock`);
  const token = randomUUID();
  const temporary = `${path}.import-${token}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(
      JSON.stringify({
        version: 1,
        token,
        pid: process.pid,
        hostname: hostname(),
        startedAt: Date.now(),
        clientIdentity: 'autokimi-session-import',
      }),
    );
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`AutoKimi session ${id} is busy.`, { cause: error });
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return async () => {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (
        info.isFile() &&
        info.nlink === 1 &&
        info.size <= 16384 &&
        (JSON.parse(await file.readFile('utf8')) as { token?: unknown })
          .token === token
      )
        await rm(path);
    } finally {
      await file.close();
    }
  };
}

export async function importKimiSession(
  homeDir: string,
  id: string,
): Promise<LegacyKimiSession> {
  component(id);
  const candidates = (await listLegacyKimiSessions(homeDir)).filter(
    (entry) => entry.id === id,
  );
  if (candidates.length !== 1)
    throw new Error(`Expected exactly one legacy session matching ${id}.`);
  const selected = candidates[0]!;
  const root = await realpath(join(homeDir, 'sessions'));
  const source = await realpath(selected.sessionDir);
  if (!source.startsWith(root + sep))
    throw new Error('Session path escaped the legacy directory.');
  const sourceLock = join(homeDir, 'locks', 'sessions', `${id}.lock`);
  if (await exists(sourceLock))
    throw new Error('Close the source Kimi session before importing it.');
  const workspace = relative(root, source).split(sep)[0]!;
  const ownRoot = join(homeDir, 'autokimi');
  await mkdir(ownRoot, { recursive: true, mode: 0o700 });
  await safeDirectory(ownRoot);
  const destinationRoot = join(ownRoot, 'sessions');
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  await safeDirectory(destinationRoot);
  const bucket = join(destinationRoot, workspace);
  await mkdir(bucket, { recursive: true, mode: 0o700 });
  await safeDirectory(bucket);
  const destination = join(bucket, id);
  if (await exists(destination))
    throw new Error(`AutoKimi session ${id} already exists.`);
  const release = await importLease(ownRoot, id);
  let staging: string | undefined;
  try {
    if (await exists(destination))
      throw new Error(`AutoKimi session ${id} already exists.`);
    staging = await mkdtemp(join(ownRoot, '.session-import-'));
    try {
      const before = await snapshot(source);
      await copySnapshot(source, join(staging, 'session'));
      if ((await exists(sourceLock)) || before !== (await snapshot(source)))
        throw new Error(
          'The source session changed during import. Close it and retry.',
        );
      await rename(join(staging, 'session'), destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } finally {
    await release();
  }
  return { ...selected, sessionDir: destination };
}
