import { describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '@moonshot-ai/pi-tui';
import { PermissionSelectorComponent } from '#/tui/components/dialogs/permission-selector';

const plain = (text: string): string =>
  text.replaceAll(/\u001B\[[0-9;]*m/g, '');

describe('native permission picker', () => {
  it('marks unavailable review and explains how selecting it opens enablement', () => {
    const onSelect = vi.fn();
    const picker = new PermissionSelectorComponent({ currentValue: 'manual', reviewEnabled: false, onSelect, onCancel: vi.fn() });
    const screen = picker.render(100).map(plain).join('\n');
    expect(screen).toContain('Auto Review (not enabled)');
    expect(screen).toContain('Select to enable the experimental capability');
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('review');
    expect(picker.render(24).every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  it('renders all four modes with the selected mode marked current', () => {
    const picker = new PermissionSelectorComponent({
      currentValue: 'review',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(100).map(plain);
    expect(
      lines
        .join('\n')
        .match(/Always Ask|Auto Review|Ask When Needed|Never Ask/g),
    ).toEqual(['Always Ask', 'Auto Review', 'Ask When Needed', 'Never Ask']);
    expect(lines.find((line) => line.includes('Auto Review'))).toContain(
      '← current',
    );
    expect(lines.filter((line) => /^─+$/.test(line))).toHaveLength(2);
    expect(picker.render(24).every((line) => visibleWidth(line) <= 24)).toBe(
      true,
    );
  });

  it('selects review by keyboard and supports cancellation', () => {
    const onSelect = vi.fn(),
      onCancel = vi.fn();
    const picker = new PermissionSelectorComponent({
      currentValue: 'manual',
      onSelect,
      onCancel,
    });
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('review');
    picker.handleInput('\u001B');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
