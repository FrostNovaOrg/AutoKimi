import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { ReviewApprovalComponent } from '#/tui/components/dialogs/review-approval';

const record = {
  toolCallId: 'call',
  challenge: 'challenge',
  fingerprint: 'a'.repeat(64),
  toolName: 'Bash',
  reason: 'Needs exact authorization',
  args: { command: 'npm test' },
  cwd: '/workspace',
};
function fixture(args = record.args) {
  const approve = vi.fn(async () => true);
  const done = vi.fn();
  const picker = new ReviewApprovalComponent({
    records: [{ ...record, args }],
    workDir: '/fallback',
    rows: () => 24,
    approve,
    cancel: vi.fn(),
    done,
    render: vi.fn(),
  });
  return { picker, approve, done };
}
const plain = (picker: ReviewApprovalComponent, width = 80): string =>
  picker.render(width).map(stripVTControlCharacters).join('\n');

describe('review approval confirmation', () => {
  it.each([' ', '\x1B[32u'])(
    'ignores Space and requires an explicit second choice (%j)',
    async (key) => {
      const t = fixture();
      t.picker.handleInput(key);
      expect(t.approve).not.toHaveBeenCalled();
      for (let i = 0; i < 4; i++) {
        t.picker.handleInput('\r');
        plain(t.picker);
      }
      expect(t.approve).not.toHaveBeenCalled();
      t.picker.handleInput('\r');
      plain(t.picker);
      t.picker.handleInput('\x1B[F');
      plain(t.picker);
      t.picker.handleInput('\t');
      t.picker.handleInput('\r');
      await vi.waitFor(() => expect(t.done).toHaveBeenCalledOnce());
      expect(t.approve).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/workspace' }),
      );
    },
  );

  it.each([40, 80, 120])(
    'shows the complete long argument without overflowing a 24-row terminal at width %s',
    (width) => {
      const t = fixture({ command: '中文路径/'.repeat(70) + 'TAIL_SENTINEL' });
      t.picker.handleInput('\r');
      const seen: string[] = [];
      for (let i = 0; i < 100; i++) {
        const lines = t.picker.render(width);
        expect(lines.length).toBeLessThanOrEqual(20);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        seen.push(...lines.map(stripVTControlCharacters));
        t.picker.handleInput('\x1B[6~');
      }
      expect(seen.join('\n')).toContain('TAIL_SENTINEL');
      expect(seen.join('\n')).toContain('/workspace');
    },
  );

  it('requires scrolling to the end before approving and keeps Cancel selected initially', () => {
    const t = fixture({ command: 'unbroken'.repeat(200) });
    t.picker.handleInput('\r');
    plain(t.picker);
    t.picker.handleInput('\t');
    t.picker.handleInput('\r');
    expect(t.approve).not.toHaveBeenCalled();
    t.picker.handleInput('\x1B[F');
    plain(t.picker);
    t.picker.handleInput('\r');
    expect(t.approve).toHaveBeenCalledOnce();
  });

  it('bounds a long denial list and sanitizes terminal controls', () => {
    const t = new ReviewApprovalComponent({
      records: Array.from({ length: 10 }, (_, i) => ({
        ...record,
        toolCallId: String(i),
        reason: 'x\x1B[2J' + 'reason '.repeat(100),
      })),
      workDir: '/workspace',
      rows: () => 24,
      approve: vi.fn(),
      cancel: vi.fn(),
      done: vi.fn(),
      render: vi.fn(),
    });
    expect(t.render(40).length).toBeLessThanOrEqual(20);
    expect(t.render(40).join('')).not.toContain('\x1B[2J');
    expect(plain(t, 40)).toContain('Page 4/4');
  });
});
