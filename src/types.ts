import { z } from 'zod';

export const STATUSES = ['todo', 'active', 'blocked', 'done', 'dropped'] as const;
export const KINDS = ['bug', 'feature', 'rework', 'decision'] as const;
export const SEVERITIES = ['S1', 'S2', 'S3', 'S4'] as const;

export type Status = (typeof STATUSES)[number];
export type Kind = (typeof KINDS)[number];
export type Severity = (typeof SEVERITIES)[number];

const itemId = z.number().int().positive();

export const ItemMetaSchema = z
  .object({
    id: itemId,
    title: z.string().min(1),
    kind: z.enum(KINDS),
    status: z.enum(STATUSES),
    sev: z.enum(SEVERITIES).optional(),
    created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    started: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    closed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    wt: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    needs: z.string().min(1).optional(),
    after: z.array(itemId).optional(),
    parent: itemId.optional(),
    verified: z.boolean().optional(),
    outcome: z.string().min(1).optional(),
    report: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    attest: z.record(z.string(), z.string()).optional(),
    attestReason: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((meta, ctx) => {
    const need = (field: keyof typeof meta, message: string): void => {
      if (meta[field] === undefined) {
        ctx.addIssue({ code: 'custom', path: [field], message });
      }
    };
    if (meta.status === 'active') {
      need('wt', 'active items require wt');
      need('branch', 'active items require branch');
    }
    if (meta.status === 'blocked') need('needs', 'blocked items require needs');
    if (meta.status === 'done') {
      need('outcome', 'done items require outcome');
      need('closed', 'done items require closed');
    }
    if (meta.status === 'dropped') {
      need('reason', 'dropped items require reason');
      need('closed', 'dropped items require closed');
    }
    if (meta.sev !== undefined && meta.kind !== 'bug') {
      ctx.addIssue({ code: 'custom', path: ['sev'], message: 'sev is only valid for bugs' });
    }
  });

export type ItemMeta = z.infer<typeof ItemMetaSchema>;

export interface Item {
  meta: ItemMeta;
  body: string;
  /** Absolute path of the item file. */
  file: string;
}

const GateSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});

const AttestationSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().min(1),
  /** If any changed file matches one of these globs, the attestation cannot be "n/a" unless a required file changed too. */
  watch: z.array(z.string()).default([]),
  /** Globs of files that satisfy the attestation when changed. */
  require: z.array(z.string()).default([]),
});

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    integrationBranch: z.string().min(1),
    todosDir: z.string().min(1).default('docs/todos'),
    indexFile: z.string().min(1).default('docs/TODO.md'),
    reportFile: z.string().min(1).nullable().default(null),
    worktreeDir: z.string().min(1).optional(),
    leaseMinutes: z.number().int().positive().default(30),
    /** Appended to every bookkeeping commit message, e.g. " [skip ci]". */
    commitSuffix: z.string().default(''),
    gates: z.array(GateSchema).default([]),
    /** How many `wg done` calls may run their gates at the same time; the rest wait for a slot. */
    gateConcurrency: z.number().int().positive().default(1),
    /** How long `wg done` waits for a free gate slot before giving up without merging. */
    gateWaitMinutes: z.number().positive().default(8),
    attestations: z.array(AttestationSchema).default([]),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type Attestation = z.infer<typeof AttestationSchema>;

export interface Repo {
  /** Root of the worktree the command runs in. */
  toplevel: string;
  /** Root of the main checkout (where item files are authoritative). */
  mainRoot: string;
  /** Shared git directory of all worktrees. */
  commonDir: string;
  /** Untracked, per-clone state (leases, bypass). */
  stateDir: string;
  config: Config;
}
