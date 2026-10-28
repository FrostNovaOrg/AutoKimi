import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

let dir: string;
let fs: HostFileSystem;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kimi-hostfs-'));
  fs = new HostFileSystem();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('HostFileSystem stat / lstat', () => {
  it('stat follows a symlink to a regular file while lstat stats the link', async () => {
    const target = join(dir, 'target.txt');
    await writeFile(target, 'hello', 'utf-8');
    const link = join(dir, 'link.txt');
    await symlink(target, link);

    const st = await fs.stat(link);
    expect(st.isFile).toBe(true);
    expect(st.isSymbolicLink).not.toBe(true);

    const lst = await fs.lstat(link);
    expect(lst.isSymbolicLink).toBe(true);
    expect(lst.isFile).toBe(false);
  });

  it('stat follows a symlink to a directory', async () => {
    const target = join(dir, 'subdir');
    await mkdir(target);
    const link = join(dir, 'dirlink');
    await symlink(target, link);

    expect((await fs.stat(link)).isDirectory).toBe(true);
    expect((await fs.lstat(link)).isDirectory).toBe(false);
  });

  it('stat rejects a dangling symlink while lstat still stats the link', async () => {
    const link = join(dir, 'dangling');
    await symlink(join(dir, 'missing'), link);

    await expect(fs.stat(link)).rejects.toThrow();
    expect((await fs.lstat(link)).isSymbolicLink).toBe(true);
  });
});

describe('HostFileSystem streamed UTF-8 lines', () => {
  it('preserves Unicode across chunks, CRLF, and a BOM after the first line', async () => {
    const path = join(dir, 'unicode.txt');
    const first = 'a'.repeat(65_531) + '🙂é\r\n';
    const second = '\uFEFFsecond\n';
    await writeFile(path, '\uFEFF' + first + second + 'last');
    const lines: string[] = [];
    for await (const line of fs.readLines(path)) lines.push(line);
    expect(lines).toEqual([first, second, 'last']);
  });

  it('rejects malformed UTF-8 rather than replacing bytes in strict mode', async () => {
    const path = join(dir, 'invalid.txt');
    await writeFile(path, Buffer.from([0x61, 0x0a, 0xc3]));
    const read = async () => {
      for await (const _line of fs.readLines(path, { errors: 'strict' })) {}
    };
    await expect(read()).rejects.toThrow();
  });
});

describe('safe file replacement', () => {
  it('rejects hardlinked text, binary and append targets without altering their inode', async () => {
    const protectedFile = join(dir, 'AGENTS.md'); const alias = join(dir, 'note.txt');
    await writeFile(protectedFile, 'original'); await link(protectedFile, alias);
    for (const operation of [() => fs.writeText(alias, 'changed'), () => fs.writeBytes(alias, Buffer.from('changed')), () => fs.appendText(alias, 'changed')]) {
      await expect(operation()).rejects.toThrow('hard-linked');
      expect(await readFile(protectedFile, 'utf8')).toBe('original');
    }
  });
  it('writes and appends ordinary files, following an ordinary file symlink safely', async () => {
    const target = join(dir, 'note.txt'); const alias = join(dir, 'note-link');
    await fs.writeText(target, 'first'); await symlink(target, alias);
    await fs.appendText(alias, ' second'); expect(await readFile(target, 'utf8')).toBe('first second');
    await fs.writeBytes(alias, Buffer.from('final')); expect(await readFile(target, 'utf8')).toBe('final');
  });
});
