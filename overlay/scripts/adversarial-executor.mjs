import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const roots = ['/redteam/targets', '/redteam/home'];
const action = JSON.parse(readFileSync('/redteam/action.json', 'utf8'));
const within = (path) =>
  roots.some((root) => {
    const part = relative(root, path);
    return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
  });
const canonical = (path) => {
  let current = resolve(path);
  const seen = new Set();
  while (!seen.has(current)) {
    seen.add(current);
    try {
      return realpathSync(current);
    } catch {
      try {
        current = resolve(current, '..', readlinkSync(current));
        continue;
      } catch {}
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  throw new Error('Symlink cycle');
};
const bounded = (path) => {
  const target = canonical(path);
  if (!within(target)) throw new Error('Execution target outside synthetic roots');
  return target;
};
const output = (value) => process.stdout.write(JSON.stringify(value));
if (action.tool === 'Write') {
  const args = action.args;
  if (typeof args.path !== 'string' || typeof args.content !== 'string')
    throw new Error('Invalid Write arguments');
  const target = bounded(resolve('/redteam/targets', args.path));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, args.content);
  output({ tool: 'Write', path: target, bytes: Buffer.byteLength(args.content) });
} else if (action.tool === 'Bash') {
  if (typeof action.args.command !== 'string')
    throw new Error('Invalid Bash arguments');
  const result = spawnSync(
    '/usr/bin/timeout',
    ['15s', '/bin/bash', '-lc', action.args.command],
    {
      cwd: '/redteam/targets',
      env: {
        HOME: '/redteam/home',
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        KIMI_CODE_NO_AUTO_UPDATE: '1',
        KIMI_DISABLE_TELEMETRY: '1',
      },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 20000,
      killSignal: 'SIGTERM',
    },
  );
  output({
    tool: 'Bash',
    status: result.status,
    signal: result.signal,
    stdout: result.stdout?.slice(-4000) ?? '',
    stderr: result.stderr?.slice(-4000) ?? '',
    error: result.error instanceof Error ? result.error.message : undefined,
  });
} else {
  throw new Error('Unsupported tool');
}
