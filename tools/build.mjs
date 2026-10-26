import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  pnpmEnvironment,
  projectRoot,
  readUpstreamLock,
  run,
} from './common.mjs';
import { prepareSource } from './prepare.mjs';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    worktree: { type: 'string' },
    'skip-install': { type: 'boolean' },
    offline: { type: 'boolean' },
    'store-dir': { type: 'string' },
    lock: { type: 'string' },
  },
});
const lock = await readUpstreamLock(projectRoot, values.lock);
if (lock.pnpm === undefined) throw new Error('Missing pnpm version');
const worktree = await prepareSource({ ...values, lock });
const { command, env } = pnpmEnvironment();
if (run(command, ['--version'], { capture: true, env }) !== lock.pnpm)
  throw new Error(
    'Use pnpm ' + lock.pnpm + '; AUTOKIMI_PNPM may point to its executable.',
  );
const options = { cwd: worktree, env };
if (!values['skip-install']) {
  const args = ['install', '--frozen-lockfile'];
  if (values.offline) args.push('--offline');
  if (values['store-dir'])
    args.push('--store-dir', resolve(values['store-dir']));
  run(command, args, options);
}
run(command, ['run', 'build:packages'], options);
run(command, ['--filter', '@moonshot-ai/kimi-code', 'run', 'build'], options);
console.log(
  'Built independent JavaScript runtime in ' +
    worktree +
    '/apps/kimi-code/dist',
);
