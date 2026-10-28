import { stripVTControlCharacters } from 'node:util';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import type { ApprovalReviewDenial } from '#/tui/commands/review-state';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';

interface ReviewApprovalOptions {
  records: readonly ApprovalReviewDenial[];
  workDir: string;
  rows: () => number;
  approve: (record: ApprovalReviewDenial) => Promise<boolean>;
  cancel: () => void;
  done: () => void;
  render: () => void;
}

const plain = (text: string): string =>
  stripVTControlCharacters(text).replaceAll(
    /[\u0000-\u0008\u000B-\u001F\u007F]/g,
    '',
  );

export class ReviewApprovalComponent extends Container implements Focusable {
  focused = false;
  private readonly list: SearchableList<ApprovalReviewDenial>;
  private phase: 'list' | 'details' | 'sending' = 'list';
  private offset = 0;
  private detailHeight = 1;
  private detailLength = 0;
  private approveSelected = false;
  private reviewed = false;
  private disposed = false;

  constructor(private readonly opts: ReviewApprovalOptions) {
    super();
    this.list = new SearchableList({
      items: opts.records,
      toSearchText: (record) => record.toolName,
      pageSize: 3,
      initialIndex: Math.max(0, opts.records.length - 1),
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  handleInput(data: string): void {
    if (this.disposed || this.phase === 'sending') return;
    if (matchesKey(data, Key.escape)) {
      if (this.phase === 'details') this.phase = 'list';
      else this.opts.cancel();
      return;
    }
    if (this.phase === 'list') {
      if (matchesKey(data, Key.enter) && this.list.selected() !== undefined) {
        this.phase = 'details';
        this.offset = 0;
        this.reviewed = false;
        this.approveSelected = false;
      } else this.list.handleKey(data);
      return;
    }
    if (
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.right)
    ) {
      this.approveSelected = !this.approveSelected;
      return;
    }
    const maxOffset = Math.max(0, this.detailLength - this.detailHeight);
    if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    if (matchesKey(data, Key.down))
      this.offset = Math.min(maxOffset, this.offset + 1);
    if (matchesKey(data, Key.pageUp))
      this.offset = Math.max(0, this.offset - this.detailHeight);
    if (matchesKey(data, Key.pageDown))
      this.offset = Math.min(maxOffset, this.offset + this.detailHeight);
    if (matchesKey(data, Key.home)) this.offset = 0;
    if (matchesKey(data, Key.end)) this.offset = maxOffset;
    if (!matchesKey(data, Key.enter)) return;
    if (!this.approveSelected) {
      this.phase = 'list';
      return;
    }
    const record = this.list.selected();
    if (record === undefined || !this.reviewed) return;
    this.phase = 'sending';
    this.opts.render();
    void this.opts
      .approve(record)
      .then((approved) => {
        if (this.disposed) return;
        if (approved) this.opts.done();
        else {
          this.phase = 'details';
          this.approveSelected = false;
          this.opts.render();
        }
      })
      .catch(() => {
        if (this.disposed) return;
        this.phase = 'details';
        this.approveSelected = false;
        this.opts.render();
      });
  }

  override render(width: number): string[] {
    width = Math.max(1, width);
    const detail = this.phase !== 'list';
    const hint =
      this.phase === 'sending'
        ? 'Sending one-time approval…'
        : detail
          ? '↑↓ scroll · PgUp/PgDn page · Tab select · Enter confirm · Esc cancel'
          : '↑↓ navigate · PgUp/PgDn page · Enter details · Esc cancel';
    const lines = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg(
        'primary',
        detail ? ' Confirm one-time approval' : ' Review denied actions',
      ),
      ...wrapTextWithAnsi(hint, Math.max(1, width - 1)).map((line) =>
        currentTheme.fg('textMuted', ` ${line}`),
      ),
      '',
    ];
    const height = Math.max(8, Math.min(20, this.opts.rows() - 5));
    if (detail) {
      const record = this.list.selected()!;
      const text = `Tool: ${record.toolName}\nWorking directory: ${record.cwd ?? this.opts.workDir}\nReason: ${record.reason}\nArguments:\n${JSON.stringify(record.args, null, 2)}\n\nOnly this identical retry is authorized. It must pass auto-review again. No permission rule is changed.`;
      const body = plain(text)
        .split('\n')
        .flatMap((line) =>
          line.length === 0
            ? ['']
            : wrapTextWithAnsi(line, Math.max(1, width - 2)),
        );
      this.detailLength = body.length;
      this.detailHeight = Math.max(1, height - lines.length - 5);
      this.offset = Math.min(
        this.offset,
        Math.max(0, body.length - this.detailHeight),
      );
      this.reviewed ||= this.offset + this.detailHeight >= body.length;
      lines.push(
        ...body
          .slice(this.offset, this.offset + this.detailHeight)
          .map((line) => currentTheme.fg('text', ` ${line}`)),
      );
      lines.push(
        currentTheme.fg(
          'textMuted',
          ` Lines ${this.offset + 1}-${Math.min(body.length, this.offset + this.detailHeight)}/${body.length}${this.reviewed ? '' : ' · scroll to end before approving'}`,
        ),
      );
      const cancelLabel = ` ${this.approveSelected ? ' ' : SELECT_POINTER} Cancel`;
      const approveLabel = ` ${this.approveSelected ? SELECT_POINTER : ' '} Approve this action once${this.reviewed ? '' : ' (review full details first)'}`;
      lines.push(
        this.approveSelected
          ? currentTheme.fg('text', cancelLabel)
          : currentTheme.boldFg('primary', cancelLabel),
      );
      lines.push(
        this.approveSelected
          ? currentTheme.boldFg('error', approveLabel)
          : currentTheme.fg('textMuted', approveLabel),
      );
    } else {
      const view = this.list.view();
      if (view.items.length === 0)
        lines.push(currentTheme.fg('textMuted', ' No eligible model denials.'));
      for (let i = view.page.start; i < view.page.end; i++) {
        const record = view.items[i]!;
        const selected = i === view.selectedIndex;
        const label = ` ${selected ? SELECT_POINTER : ' '} ${plain(record.toolName)}: ${plain(record.reason).replaceAll('\n', ' ')}`;
        lines.push(
          selected
            ? currentTheme.boldFg('primary', label)
            : currentTheme.fg('text', label),
        );
        lines.push(
          currentTheme.fg(
            'textMuted',
            `   ${plain(JSON.stringify(record.args))}`,
          ),
        );
      }
      lines.push(
        '',
        currentTheme.fg(
          'textMuted',
          ` Page ${view.page.page + 1}/${Math.max(1, view.page.pageCount)} · ${view.items.length} actions`,
        ),
      );
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
