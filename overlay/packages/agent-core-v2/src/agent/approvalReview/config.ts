import { z } from 'zod';
import { registerFlagDefinition } from '#/app/flag/flagRegistry';

export const APPROVAL_REVIEW_FLAG = 'approval_review';

registerFlagDefinition({
  id: APPROVAL_REVIEW_FLAG,
  title: 'Model approval reviewer',
  description:
    'Review pending tool approvals with a separate model call; uncertain or failed reviews deny the action. Select Auto Review permission mode.',
  env: 'KIMI_CODE_EXPERIMENTAL_APPROVAL_REVIEW',
  default: true,
  surface: 'core',
});

export const ApprovalReviewConfigSchema = z
  .object({
    model: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).default(30000),
    maxContextChars: z.number().int().min(4000).max(100000).default(60000),
    twoStage: z.boolean().default(true),
    shellSandbox: z.boolean().default(true),
    shellAllowedDomains: z.array(z.string().min(1)).max(100).default([]),
    policy: z.string().max(8000).optional(),
  })
  .strict();

export type ApprovalReviewConfig = z.infer<typeof ApprovalReviewConfigSchema>;
