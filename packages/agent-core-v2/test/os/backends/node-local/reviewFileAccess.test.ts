import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import {
  prepareReviewedFileAccess,
  protectedReviewedFileAccess,
  reviewedFileAccessCurrent,
  runWithReviewedFileAccess,
} from '#/os/backends/node-local/reviewFileAccess';

const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as (() => Promise<void>) | undefined,
  beforeLink: undefined as (() => Promise<void>) | undefined,
  afterLink: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const hook = hooks.beforeOpen;
      hooks.beforeOpen = undefined;
      await hook?.();
      return actual.open(...args);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      const hook = hooks.beforeLink;
      hooks.beforeLink = undefined;
      await hook?.();
      await actual.link(...args);
      const after = hooks.afterLink;
      hooks.afterLink = undefined;
      await after?.();
    },
  };
});

let dir: string;
let fs: HostFileSystem;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'kimi-reviewed-file-')));
  fs = new HostFileSystem();
});

afterEach(async () => {
  hooks.beforeOpen = undefined;
  hooks.beforeLink = undefined;
  hooks.afterLink = undefined;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function prepare(path: string) {
  const execution = {};
  prepareReviewedFileAccess(execution, [{ path, operation: 'write' }], dir);
  return execution;
}

describe('reviewed file identity', () => {
  it('rejects an unreviewed parent introduced after approval of a missing path', async () => {
    const parent = join(dir, 'new-directory');
    const path = join(parent, 'notes.txt');
    const execution = prepare(path);
    await mkdir(parent);
    expect(reviewedFileAccessCurrent(execution)).toBe(false);
    await expect(async () =>
      runWithReviewedFileAccess(execution, () => fs.writeText(path, 'changed')),
    ).rejects.toThrow('changed');
    expect(await readdir(parent)).toEqual([]);
  });

  it.each(['text', 'bytes', 'append'])(
    'writes approved %s data through the original file identity',
    async (operation) => {
      const path = join(dir, 'notes.txt');
      await writeFile(path, 'original');
      await chmod(path, 0o640);
      const before = await stat(path);
      const execution = prepare(path);
      await runWithReviewedFileAccess(execution, () =>
        operation === 'append'
          ? fs.appendText(path, ' changed')
          : operation === 'bytes'
            ? fs.writeBytes(path, Buffer.from('changed'))
            : fs.writeText(path, 'changed'),
      );
      expect(await readFile(path, 'utf8')).toBe(
        operation === 'append' ? 'original changed' : 'changed',
      );
      expect(await stat(path)).toMatchObject({
        ino: before.ino,
        dev: before.dev,
        mode: before.mode,
      });
    },
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'creates a new file and missing parents using approved directory identities',
    async () => {
      const path = join(dir, 'nested', 'deeper', 'notes.txt');
      const execution = prepare(path);
      await runWithReviewedFileAccess(execution, async () => {
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeText(path, '请参考 AGENTS.md');
      });
      expect(await readFile(path, 'utf8')).toBe('请参考 AGENTS.md');
      expect(await readdir(dirname(path))).toEqual(['notes.txt']);
    },
  );

  it.runIf(process.platform === 'win32')(
    'denies new reviewed files without an identity based directory API',
    async () => {
      const path = join(dir, 'notes.txt');
      await expect(
        runWithReviewedFileAccess(prepare(path), () =>
          fs.writeText(path, 'changed'),
        ),
      ).rejects.toThrow('unavailable');
      expect(await readdir(dir)).toEqual([]);
    },
  );

  it.each(['symlink', 'inode', 'parent', 'content', 'hardlink'])(
    'rejects a changed %s after approval',
    async (change) => {
      const parent = join(dir, 'ordinary');
      const path = join(parent, 'notes.txt');
      const alias = join(dir, 'alias.txt');
      const protectedFile = join(dir, 'AGENTS.md');
      await mkdir(parent);
      await writeFile(path, 'original');
      await writeFile(protectedFile, 'preserve');
      await symlink(path, alias);
      const execution = prepare(alias);
      if (change === 'symlink') {
        await unlink(alias);
        await symlink(protectedFile, alias);
      } else if (change === 'inode') {
        await rename(path, path + '.old');
        await writeFile(path, 'replacement');
      } else if (change === 'parent') {
        await rename(parent, parent + '.old');
        await mkdir(parent);
        await writeFile(path, 'replacement');
      } else if (change === 'content') {
        await writeFile(path, 'other process');
      } else {
        await link(path, join(dir, 'another-link'));
      }
      expect(reviewedFileAccessCurrent(execution)).toBe(false);
      await expect(async () =>
        runWithReviewedFileAccess(execution, () =>
          fs.writeText(alias, 'changed'),
        ),
      ).rejects.toThrow('changed');
      expect(await readFile(protectedFile, 'utf8')).toBe('preserve');
    },
  );

  it('rechecks targets after execution starts and before the actual file open', async () => {
    const path = join(dir, 'notes.txt');
    const protectedFile = join(dir, 'AGENTS.md');
    const alias = join(dir, 'alias');
    await writeFile(path, 'original');
    await writeFile(protectedFile, 'preserve');
    await symlink(path, alias);
    const execution = prepare(alias);
    await expect(
      runWithReviewedFileAccess(execution, async () => {
        await unlink(alias);
        await symlink(protectedFile, alias);
        await fs.writeText(alias, 'changed');
      }),
    ).rejects.toThrow('changed');
    expect(await readFile(protectedFile, 'utf8')).toBe('preserve');
    expect(await readFile(path, 'utf8')).toBe('original');
  });

  it('keeps a late symlink swap from redirecting an already opened write', async () => {
    const path = join(dir, 'notes.txt');
    const protectedFile = join(dir, 'AGENTS.md');
    const alias = join(dir, 'alias');
    await writeFile(path, 'original');
    await writeFile(protectedFile, 'preserve');
    await symlink(path, alias);
    const sample = await open(path, 'r');
    const prototype = Object.getPrototypeOf(sample) as typeof sample;
    const truncate = prototype.truncate;
    await sample.close();
    vi.spyOn(prototype, 'truncate').mockImplementationOnce(async function (
      this: typeof sample,
      length,
    ) {
      await unlink(alias);
      await symlink(protectedFile, alias);
      return truncate.call(this, length);
    });
    await runWithReviewedFileAccess(prepare(alias), () =>
      fs.writeText(alias, 'changed'),
    );
    expect(await readFile(protectedFile, 'utf8')).toBe('preserve');
    expect(await readFile(path, 'utf8')).toBe('changed');
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'anchors a pending open to its approved directory when the path is replaced',
    async () => {
      const parent = join(dir, 'ordinary');
      const protectedParent = join(dir, '.agents');
      const path = join(parent, 'notes.txt');
      const protectedFile = join(protectedParent, 'notes.txt');
      await mkdir(parent);
      await mkdir(protectedParent);
      await writeFile(protectedFile, 'preserve');
      const execution = prepare(path);
      hooks.beforeOpen = async () => {
        await rename(parent, parent + '.old');
        await symlink(protectedParent, parent);
      };
      await expect(
        runWithReviewedFileAccess(execution, () =>
          fs.writeText(path, 'changed'),
        ),
      ).rejects.toThrow('changed');
      expect(await readFile(protectedFile, 'utf8')).toBe('preserve');
      expect(await readdir(parent + '.old')).toEqual([]);
    },
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'does not overwrite a target introduced during new-file installation',
    async () => {
      const path = join(dir, 'notes.txt');
      const protectedFile = join(dir, 'AGENTS.md');
      await writeFile(protectedFile, 'preserve');
      const execution = prepare(path);
      hooks.beforeLink = () => symlink(protectedFile, path);
      await expect(
        runWithReviewedFileAccess(execution, () =>
          fs.writeText(path, 'changed'),
        ),
      ).rejects.toThrow();
      expect(await readFile(protectedFile, 'utf8')).toBe('preserve');
      expect(await readdir(dir)).toEqual(['AGENTS.md', 'notes.txt']);
    },
  );

  it('does not permit writes or directory creation outside the declared action', async () => {
    const path = join(dir, 'notes.txt');
    const other = join(dir, 'other.txt');
    await writeFile(path, 'original');
    await writeFile(other, 'preserve');
    await runWithReviewedFileAccess(prepare(path), async () => {
      await expect(fs.writeText(other, 'changed')).rejects.toThrow('not part');
      await expect(
        fs.mkdir(join(dir, 'other-directory'), { recursive: true }),
      ).rejects.toThrow('not part');
    });
    expect(await readFile(other, 'utf8')).toBe('preserve');
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'does not delete an unreviewed replacement when new-file verification fails',
    async () => {
      const path = join(dir, 'notes.txt');
      const execution = prepare(path);
      hooks.afterLink = async () => {
        await rename(path, path + '.old');
        await writeFile(path, 'concurrent data');
      };
      await expect(
        runWithReviewedFileAccess(execution, () =>
          fs.writeText(path, 'changed'),
        ),
      ).rejects.toThrow('changed');
      expect(await readFile(path, 'utf8')).toBe('concurrent data');
    },
  );

  it('isolates concurrent reviewed tool calls', async () => {
    const first = join(dir, 'first.txt');
    const second = join(dir, 'second.txt');
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    const firstExecution = prepare(first);
    const secondExecution = prepare(second);
    await Promise.all([
      runWithReviewedFileAccess(firstExecution, async () => {
        await Promise.resolve();
        await expect(fs.writeText(second, 'wrong action')).rejects.toThrow(
          'not part',
        );
        await fs.writeText(first, 'one');
      }),
      runWithReviewedFileAccess(secondExecution, () =>
        fs.writeText(second, 'two'),
      ),
    ]);
    expect(await readFile(first, 'utf8')).toBe('one');
    expect(await readFile(second, 'utf8')).toBe('two');
  });

  it('checks actual requested and resolved paths without inspecting document contents', async () => {
    const path = join(dir, 'notes.txt');
    const protectedFile = join(dir, 'AGENTS.md');
    const alias = join(dir, 'ordinary-alias');
    await writeFile(path, '请参考 AGENTS.md');
    await writeFile(protectedFile, 'instructions');
    await symlink(protectedFile, alias);
    expect(
      protectedReviewedFileAccess(
        prepareReviewedFileAccess({}, [{ path, operation: 'write' }], dir),
        join(dir, 'home'),
      ),
    ).toBe(false);
    expect(
      protectedReviewedFileAccess(
        prepareReviewedFileAccess(
          {},
          [{ path: alias, operation: 'write' }],
          dir,
        ),
        join(dir, 'home'),
      ),
    ).toBe(true);
  });
});
