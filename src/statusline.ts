import { z } from 'zod';
import { computeStats } from './derive.js';
import { loadAll } from './items.js';
import { itemForToplevel } from './ops.js';
import { tryResolveRepo } from './repo.js';

const InputSchema = z
  .object({
    model: z.object({ display_name: z.string().optional() }).optional(),
    output_style: z.object({ name: z.string().optional() }).optional(),
    cwd: z.string().optional(),
    workspace: z.object({ project_dir: z.string().optional(), current_dir: z.string().optional() }).optional(),
    context_window: z.object({ remaining_percentage: z.number().nullable().optional() }).optional(),
    rate_limits: z
      .object({
        five_hour: z
          .object({ used_percentage: z.number().nullable().optional(), resets_at: z.number().nullable().optional() })
          .optional(),
        seven_day: z.object({ used_percentage: z.number().nullable().optional() }).optional(),
      })
      .optional(),
  })
  .loose();

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[2;36m';
const YELLOW = '\x1b[2;33m';
const MAGENTA = '\x1b[2;35m';
const RED = '\x1b[2;31m';
const GREEN = '\x1b[2;32m';

function paint(color: string, text: string): string {
  return `${color}${text}${RESET}`;
}

export function formatReset(resetsAt: number, nowSeconds: number): string {
  const diff = resetsAt - nowSeconds;
  if (diff <= 0) return '(reset)';
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return h > 0 ? `(${h}h ${m}m)` : `(${m}m)`;
}

export async function renderStatusline(rawInput: string, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<string> {
  let data: z.infer<typeof InputSchema> = {};
  try {
    const parsed = InputSchema.safeParse(JSON.parse(rawInput));
    if (parsed.success) data = parsed.data;
  } catch {
    data = {};
  }
  const parts: string[] = [];

  const five = data.rate_limits?.five_hour?.used_percentage;
  const week = data.rate_limits?.seven_day?.used_percentage;
  const resetsAt = data.rate_limits?.five_hour?.resets_at;
  if (typeof five === 'number' || typeof week === 'number') {
    const rl: string[] = [];
    if (typeof five === 'number') {
      const reset = typeof resetsAt === 'number' ? ` ${formatReset(resetsAt, nowSeconds)}` : '';
      rl.push(`5h:${Math.round(five)}%${reset}`);
    }
    if (typeof week === 'number') rl.push(`7d:${Math.round(week)}%`);
    parts.push(paint(YELLOW, rl.join(' ')));
  }

  const remaining = data.context_window?.remaining_percentage;
  if (typeof remaining === 'number') parts.push(paint(CYAN, `ctx:${Math.round(remaining)}% left`));

  const dir = data.workspace?.project_dir ?? data.cwd ?? data.workspace?.current_dir;
  if (dir !== undefined) {
    try {
      const repo = await tryResolveRepo(dir);
      if (repo !== undefined) {
        const { items } = loadAll(repo);
        const stats = computeStats(repo, items);
        const sep = paint(DIM, '/');
        parts.push(`${paint(RED, String(stats.blocked))}${sep}${paint(YELLOW, String(stats.open))}${sep}${paint(CYAN, String(stats.total))}`);
        const current = await itemForToplevel(repo, repo.toplevel).catch(() => undefined);
        if (current !== undefined) parts.push(paint(GREEN, `#${current.meta.id}`));
      }
    } catch {
      // A broken config must never break the status line.
    }
  }

  const model = data.model?.display_name ?? 'unknown';
  const style = data.output_style?.name ?? 'default';
  parts.push(paint(MAGENTA, `${model} / ${style}`));
  return parts.join(` ${paint(DIM, '|')} `);
}
