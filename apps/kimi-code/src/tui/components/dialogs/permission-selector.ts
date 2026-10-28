import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import {
  PERMISSION_MODE_DESCRIPTIONS,
  PERMISSION_MODE_DISPLAY_NAMES,
} from '#/tui/utils/permission-mode';

import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const PERMISSION_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'manual',
    label: PERMISSION_MODE_DISPLAY_NAMES.manual,
    description: PERMISSION_MODE_DESCRIPTIONS.manual,
  },
  {
    value: 'review',
    label: PERMISSION_MODE_DISPLAY_NAMES.review,
    description: PERMISSION_MODE_DESCRIPTIONS.review,
  },
  {
    value: 'yolo',
    label: PERMISSION_MODE_DISPLAY_NAMES.yolo,
    description: PERMISSION_MODE_DESCRIPTIONS.yolo,
  },
  {
    value: 'auto',
    label: PERMISSION_MODE_DISPLAY_NAMES.auto,
    description: PERMISSION_MODE_DESCRIPTIONS.auto,
  },
];

function isPermissionModeChoice(value: string): value is PermissionMode {
  return (
    value === 'manual' ||
    value === 'review' ||
    value === 'auto' ||
    value === 'yolo'
  );
}

export interface PermissionSelectorOptions {
  readonly currentValue: PermissionMode;
  readonly initialValue?: PermissionMode;
  readonly reviewEnabled?: boolean;
  readonly onSelect: (mode: PermissionMode) => void;
  readonly onCancel: () => void;
}

export class PermissionSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PermissionSelectorOptions) {
    super({
      title: 'Select permission mode',
      options: PERMISSION_OPTIONS.map((option) =>
        option.value === 'review' && opts.reviewEnabled === false
          ? {
              ...option,
              label: 'Auto Review (not enabled)',
              description:
                'Select to enable the experimental capability, then use Auto Review for this session.',
            }
          : option,
      ),
      currentValue: opts.currentValue,
      initialValue: opts.initialValue,
      onSelect: (value) => {
        if (isPermissionModeChoice(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
