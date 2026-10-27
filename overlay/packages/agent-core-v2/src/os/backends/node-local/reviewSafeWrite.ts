import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function reviewSafeWrite(
  path: string,
  data: string | Uint8Array,
  append = false,
): Promise<void> {
  let target: string;
  try {
    target = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await lstat(path);
      throw new Error('Cannot write through an unresolved symbolic link');
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT')
        throw statError;
    }
    target = join(await realpath(dirname(path)), basename(path));
  }
  let previous: Awaited<ReturnType<typeof lstat>> | undefined;
  if (append) {
    const file = await open(
      target,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o666,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1)
        throw new HostFsError(
          OsFsErrors.codes.OS_FS_PERMISSION_DENIED,
          'Refusing to modify a hard-linked or non-regular file',
        );
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    return;
  }
  try {
    const file = await open(
      target,
      constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      previous = await file.stat();
      if (!previous.isFile() || previous.nlink !== 1)
        throw new HostFsError(
          OsFsErrors.codes.OS_FS_PERMISSION_DENIED,
          'Refusing to modify a hard-linked or non-regular file',
        );
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(target), '.autokimi-write-' + randomUUID());
  try {
    const output = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      previous === undefined ? 0o666 : Number(previous.mode) & 0o777,
    );
    try {
      const current = await output.stat();
      if (!current.isFile() || current.nlink !== 1)
        throw new Error('Unsafe temporary output');
      await output.writeFile(data);
      if (previous !== undefined)
        await output.chmod(Number(previous.mode) & 0o777);
      await output.sync();
    } finally {
      await output.close();
    }
    const current = await lstat(target).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (
      current?.isSymbolicLink() ||
      current?.nlink !== previous?.nlink ||
      current?.dev !== previous?.dev ||
      current?.ino !== previous?.ino
    )
      throw new Error('Write target changed before replacement');
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
