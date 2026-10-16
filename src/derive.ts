import { isStale, leaseAgeMinutes } from './state.js';
import type { Item, Kind, Repo, Severity, Status } from './types.js';

export interface Stats {
  /** Items waiting on the owner. */
  blocked: number;
  /** Open work that is not blocked (todo + active). */
  open: number;
  /** Every item in the list, including finished ones. */
  total: number;
  byStatus: Record<Status, number>;
  stale: number;
}

export function computeStats(repo: Repo, items: readonly Item[]): Stats {
  const byStatus: Record<Status, number> = { todo: 0, active: 0, blocked: 0, done: 0, dropped: 0 };
  let stale = 0;
  for (const item of items) {
    byStatus[item.meta.status] += 1;
    if (item.meta.status === 'active' && isStale(repo, item.meta.id)) stale += 1;
  }
  return {
    blocked: byStatus.blocked,
    open: byStatus.todo + byStatus.active,
    total: items.length,
    byStatus,
    stale,
  };
}

function isClosed(status: Status): boolean {
  return status === 'done' || status === 'dropped';
}

export function isPickable(item: Item, all: readonly Item[]): boolean {
  if (item.meta.status !== 'todo') return false;
  const deps = item.meta.after ?? [];
  return deps.every((id) => {
    const dep = all.find((i) => i.meta.id === id);
    return dep !== undefined && isClosed(dep.meta.status);
  });
}

const SEV_RANK: Record<Severity, number> = { S1: 0, S2: 1, S3: 2, S4: 3 };
const KIND_RANK: Record<Kind, number> = { bug: 0, rework: 1, feature: 2, decision: 3 };

export function compareForNext(a: Item, b: Item): number {
  const aBug = a.meta.kind === 'bug';
  const bBug = b.meta.kind === 'bug';
  if (aBug !== bBug) return aBug ? -1 : 1;
  if (aBug && bBug) {
    const sa = SEV_RANK[a.meta.sev ?? 'S4'];
    const sb = SEV_RANK[b.meta.sev ?? 'S4'];
    if (sa !== sb) return sa - sb;
  }
  const ka = KIND_RANK[a.meta.kind];
  const kb = KIND_RANK[b.meta.kind];
  if (ka !== kb) return ka - kb;
  return a.meta.id - b.meta.id;
}

export function nextItems(items: readonly Item[]): Item[] {
  return items.filter((i) => isPickable(i, items)).sort(compareForNext);
}

export interface ActiveInfo {
  id: number;
  title: string;
  stale: boolean;
  ageMinutes: number | undefined;
}

export function activeInfo(repo: Repo, item: Item): ActiveInfo {
  return {
    id: item.meta.id,
    title: item.meta.title,
    stale: isStale(repo, item.meta.id),
    ageMinutes: leaseAgeMinutes(repo, item.meta.id),
  };
}

/** Checked and unchecked checklist boxes in an item body, used as plan progress. */
export function planProgress(body: string): { done: number; total: number } {
  const done = (body.match(/^\s*- \[x\]/gim) ?? []).length;
  const open = (body.match(/^\s*- \[ \]/gm) ?? []).length;
  return { done, total: done + open };
}
