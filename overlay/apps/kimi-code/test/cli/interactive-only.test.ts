import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import {
  rejectHeadlessServer,
  restrictToInteractiveTui,
} from '#/cli/interactive-only';

function entry(stdin = true, stdout = true) {
  const run = vi.fn();
  const admin = vi.fn();
  const program = new Command('autokimi')
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} })
    .option('-p, --prompt <prompt>')
    .option('-S, --session <id>')
    .option('-c, --continue')
    .version('test')
    .action(run);
  for (const name of ['acp', 'web', 'app', 'future-agent'])
    program.command(name).action(run);
  program.command('session').command('list').action(admin);
  program.command('exec').action(admin);
  program.command('runs').command('status').action(admin);
  restrictToInteractiveTui(program, {
    stdin: { isTTY: stdin },
    stdout: { isTTY: stdout },
  });
  return { program, run, admin };
}

describe('AutoKimi interactive entry boundary', () => {
  it.each([
    ['-p', 'task'],
    ['--prompt=task'],
    ['-ptask'],
    ['--session', 'previous', '-p', 'continue'],
    ['--continue', '--prompt', 'task'],
    ['acp'],
    ['web'],
    ['app'],
    ['future-agent'],
  ])('rejects agent entry %j before starting it', (...args) => {
    const { program, run } = entry();
    expect(() => program.parse(args, { from: 'user' })).toThrow(
      /Use native kimi/,
    );
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])('rejects missing terminal %j %j', (stdin, stdout) => {
    const { program, run } = entry(stdin, stdout);
    expect(() => program.parse([], { from: 'user' })).toThrow(
      /Use native kimi/,
    );
    expect(run).not.toHaveBeenCalled();
  });
  it('allows interactive sessions and metadata commands without a terminal', () => {
    const tui = entry();
    tui.program.parse(['--continue'], { from: 'user' });
    expect(tui.run).toHaveBeenCalledOnce();
    const metadata = entry(false, false);
    metadata.program.parse(['session', 'list'], { from: 'user' });
    expect(metadata.admin).toHaveBeenCalledOnce();
  });
  it('allows only the explicit headless task and query entries without a terminal', () => {
    for (const args of [['exec'], ['runs', 'status']]) {
      const { program, admin, run } = entry(false, false);
      program.parse(args, { from: 'user' });
      expect(admin).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
    }
  });
  it('keeps help and version available without a terminal', () => {
    for (const args of [['--help'], ['--version'], ['web', '--help']]) {
      const { program, run } = entry(false, false);
      expect(() => program.parse(args, { from: 'user' })).toThrow();
      expect(run).not.toHaveBeenCalled();
    }
  });
  it('rejects foreground web takeover from an existing TUI', () => {
    expect(rejectHeadlessServer).toThrow(/Use native kimi/);
  });
});
