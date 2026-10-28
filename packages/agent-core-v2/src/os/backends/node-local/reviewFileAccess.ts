import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { link, open, rm } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';

interface FileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly links: string;
  readonly kind: 'file' | 'directory' | 'other';
  readonly version: string;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly identity: FileIdentity | undefined;
}

interface ReviewedTarget {
  readonly path: string;
  readonly requestedPath: string;
  readonly operation: string;
  readonly realPath: string;
  readonly identity: FileIdentity | undefined;
  readonly directories: readonly DirectoryIdentity[];
}

export interface ReviewedFileAccess {
  readonly cwd: string;
  readonly targets: readonly ReviewedTarget[];
}

interface ReviewedFileScope {
  readonly access: ReviewedFileAccess;
  readonly createdDirectories: Map<string, FileIdentity>;
}

const bindings = new WeakMap<object, ReviewedFileAccess>();
const scope = new AsyncLocalStorage<ReviewedFileScope>();

export const PROTECTED_REVIEW_FILE_MESSAGE =
  'This action accesses protected agent instructions or reviewer configuration and cannot be automatically authorized.';

function identity(stat: BigIntStats): FileIdentity {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    links: String(stat.nlink),
    kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
    version: `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}:${stat.uid}:${stat.gid}`,
  };
}

function sameObject(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.kind === right.kind
  );
}

function sameFile(
  left: FileIdentity | undefined,
  right: FileIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    sameObject(left, right) &&
    left.links === right.links &&
    (left.kind === 'directory' || left.version === right.version)
  );
}

function denied(
  message = 'Reviewed file target changed; resolve the action again for fresh authorization.',
): never {
  throw new HostFsError(OsFsErrors.codes.OS_FS_PERMISSION_DENIED, message);
}

function statIdentity(path: string): FileIdentity | undefined {
  try {
    return identity(lstatSync(path, { bigint: true }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

function resolvedPath(path: string): string {
  let current = path;
  const suffix: string[] = [];
  const seen = new Set<string>();
  for (let attempts = 0; attempts < 256; attempts++) {
    if (seen.has(current)) denied('Cannot verify a cyclic file access path.');
    seen.add(current);
    try {
      return resolve(realpathSync(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const stat = statIdentity(current);
      if (stat !== undefined) {
        if (lstatSync(current).isSymbolicLink()) {
          current = resolve(dirname(current), readlinkSync(current));
          continue;
        }
        denied('Cannot resolve the file access path.');
      }
      const parent = dirname(current);
      if (parent === current) denied('Cannot resolve the file access path.');
      suffix.unshift(basename(current));
      current = parent;
    }
  }
  return denied('The file access path exceeds the resolution limit.');
}

function directoryPaths(path: string): string[] {
  const paths = [path];
  while (dirname(paths[0]!) !== paths[0]) paths.unshift(dirname(paths[0]!));
  return paths;
}

export function prepareReviewedFileAccess(
  execution: object,
  requests: readonly { readonly path: string; readonly operation: string }[],
  cwd: string,
): ReviewedFileAccess {
  const existing = bindings.get(execution);
  if (existing !== undefined) {
    validateAccess(existing);
    return existing;
  }
  const targets = requests.map((request): ReviewedTarget => {
    const requestedPath = resolve(cwd, request.path);
    const realPath = resolvedPath(requestedPath);
    const directories = directoryPaths(dirname(realPath)).map((path) => {
      const current = statIdentity(path);
      if (current !== undefined && current.kind !== 'directory')
        return denied('A reviewed file parent is not a directory.');
      return { path, identity: current };
    });
    return {
      ...request,
      requestedPath,
      realPath,
      identity: statIdentity(realPath),
      directories,
    };
  });
  const access = { cwd, targets };
  bindings.set(execution, access);
  return access;
}

export function protectedReviewedFileAccess(
  access: ReviewedFileAccess,
  home: string,
): boolean {
  const homes = [resolve(home), resolvedPath(resolve(home))];
  const protectedPath = (path: string, writing: boolean): boolean =>
    /(?:^|[/\\])\.kimi-code(?:[/\\]|$)/i.test(path) ||
    (writing &&
      /(?:^|[/\\])(?:\.agents|AGENTS\.md|CLAUDE\.md|KIMI\.md)(?:[/\\]|$)/i.test(
        path,
      )) ||
    homes.some((root) => {
      const fromHome = relative(root, path);
      return (
        !isAbsolute(fromHome) &&
        fromHome !== '..' &&
        !fromHome.startsWith('..' + sep)
      );
    });
  return access.targets.some(
    (target) =>
      protectedPath(target.requestedPath, mutation(target)) ||
      protectedPath(target.realPath, mutation(target)) ||
      (target.operation !== 'read' &&
        target.operation !== 'search' &&
        target.identity?.kind === 'file' &&
        target.identity.links !== '1'),
  );
}

function validateAccess(
  access: ReviewedFileAccess,
  currentScope?: ReviewedFileScope,
): void {
  for (const target of access.targets) {
    if (
      resolvedPath(target.requestedPath) !== target.realPath ||
      !sameFile(target.identity, statIdentity(target.realPath))
    )
      denied();
    for (const directory of target.directories) {
      const current = statIdentity(directory.path);
      const expected =
        directory.identity ??
        currentScope?.createdDirectories.get(directory.path);
      if (
        expected === undefined
          ? current !== undefined
          : current === undefined || !sameObject(expected, current)
      )
        denied();
    }
  }
  for (const [path, expected] of currentScope?.createdDirectories ?? []) {
    const current = statIdentity(path);
    if (current === undefined || !sameObject(expected, current)) denied();
  }
}

export function reviewedFileAccessCurrent(execution: object): boolean {
  const access = bindings.get(execution);
  if (access === undefined) return true;
  try {
    validateAccess(access);
    return true;
  } catch {
    return false;
  }
}

export function runWithReviewedFileAccess<T>(
  execution: object,
  run: () => T,
): T {
  const access = bindings.get(execution);
  if (access === undefined || access.targets.length === 0) return run();
  validateAccess(access);
  return scope.run({ access, createdDirectories: new Map() }, run);
}

function mutation(target: ReviewedTarget): boolean {
  return target.operation !== 'read' && target.operation !== 'search';
}

function directoryAnchor(fd: number): string {
  const expected = identity(fstatSync(fd, { bigint: true }));
  const path =
    process.platform === 'linux'
      ? `/proc/self/fd/${fd}`
      : process.platform === 'darwin'
        ? `/.vol/${expected.device}/${expected.inode}`
        : undefined;
  if (
    path === undefined ||
    !sameObject(expected, identity(statSync(path, { bigint: true })))
  )
    return denied(
      'File identity based directory access is unavailable; reviewed creation was denied.',
    );
  return path;
}

function openParent(
  target: ReviewedTarget,
  currentScope: ReviewedFileScope,
  create: boolean,
): number {
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    return denied(
      'File identity based directory access is unavailable; reviewed creation was denied.',
    );
  const paths = directoryPaths(dirname(target.realPath));
  let fd = openSync(
    paths[0]!,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (let index = 0; index < paths.length; index++) {
      const path = paths[index]!;
      const expected =
        target.directories.find((entry) => entry.path === path)?.identity ??
        currentScope.createdDirectories.get(path);
      if (index > 0) {
        const child = join(directoryAnchor(fd), basename(path));
        if (expected === undefined) {
          if (!create) denied();
          mkdirSync(child);
        }
        const next = openSync(
          child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        closeSync(fd);
        fd = next;
      }
      const actual = identity(fstatSync(fd, { bigint: true }));
      if (
        actual.kind !== 'directory' ||
        (expected !== undefined && !sameObject(expected, actual))
      )
        denied();
      if (expected === undefined)
        currentScope.createdDirectories.set(path, actual);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function createReviewedParent(path: string): boolean {
  const currentScope = scope.getStore();
  if (currentScope === undefined) return false;
  const target = currentScope.access.targets.find(
    (entry) =>
      mutation(entry) &&
      dirname(entry.requestedPath) === resolve(currentScope.access.cwd, path),
  );
  if (target === undefined) {
    if (currentScope.access.targets.some(mutation))
      denied('This directory creation was not part of the reviewed action.');
    return false;
  }
  validateAccess(currentScope.access, currentScope);
  const fd = openParent(target, currentScope, true);
  closeSync(fd);
  validateAccess(currentScope.access, currentScope);
  return true;
}

export async function writeReviewedFile(
  path: string,
  data: string | Uint8Array,
  append: boolean,
): Promise<boolean> {
  const currentScope = scope.getStore();
  if (currentScope === undefined || !currentScope.access.targets.some(mutation))
    return false;
  const target = currentScope.access.targets.find(
    (entry) =>
      mutation(entry) &&
      entry.requestedPath === resolve(currentScope.access.cwd, path),
  );
  if (target === undefined)
    return denied('This file write was not part of the reviewed action.');
  validateAccess(currentScope.access, currentScope);
  let parent: number | undefined;
  let temporary: string | undefined;
  try {
    let filePath: string;
    if (process.platform === 'win32' && target.identity !== undefined) {
      filePath = target.realPath;
    } else {
      parent = openParent(target, currentScope, false);
      filePath = join(directoryAnchor(parent), basename(target.realPath));
    }
    if (target.identity === undefined) {
      temporary = join(directoryAnchor(parent!), '.kimi-write-' + randomUUID());
    }
    const file = await open(
      temporary ?? filePath,
      constants.O_WRONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (append ? constants.O_APPEND : 0) |
        (target.identity === undefined
          ? constants.O_CREAT | constants.O_EXCL
          : 0),
      0o666,
    );
    try {
      const actual = identity(await file.stat({ bigint: true }));
      if (
        actual.kind !== 'file' ||
        actual.links !== '1' ||
        (target.identity !== undefined && !sameFile(target.identity, actual))
      )
        denied();
      validateAccess(currentScope.access, currentScope);
      if (
        target.identity !== undefined &&
        !sameFile(actual, statIdentity(target.realPath))
      )
        denied();
      if (!append && target.identity !== undefined) await file.truncate(0);
      await file.writeFile(data);
      await file.sync();
      if (temporary !== undefined) {
        validateAccess(currentScope.access, currentScope);
        const completed = identity(await file.stat({ bigint: true }));
        if (completed.links !== '1') denied();
        await link(temporary, filePath);
        const installed = statIdentity(filePath);
        if (
          installed === undefined ||
          !sameObject(completed, installed) ||
          identity(await file.stat({ bigint: true })).links !== '2'
        )
          denied();
      }
    } finally {
      await file.close();
    }
    return true;
  } finally {
    try {
      if (temporary !== undefined) await rm(temporary, { force: true });
    } finally {
      if (parent !== undefined) closeSync(parent);
    }
  }
}
