import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { WgError } from './errors.js';
import type { Repo } from './types.js';

const LeaseSchema = z.object({ heartbeat: z.string() });
const BypassSchema = z.object({
  mode: z.enum(['prompt', 'timed']),
  session: z.string().optional(),
  until: z.string().optional(),
  startHead: z.string(),
  startedAt: z.string(),
});

export type Bypass = z.infer<typeof BypassSchema>;

function ensure(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function leaseFile(repo: Repo, id: number): string {
  return join(repo.stateDir, 'leases', `${id}.json`);
}

export function touchLease(repo: Repo, id: number, now: Date = new Date()): void {
  ensure(join(repo.stateDir, 'leases'));
  writeFileSync(leaseFile(repo, id), JSON.stringify({ heartbeat: now.toISOString() }));
}

export function readLease(repo: Repo, id: number): Date | undefined {
  const parsed = LeaseSchema.safeParse(readJson(leaseFile(repo, id)));
  if (!parsed.success) return undefined;
  const date = new Date(parsed.data.heartbeat);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function clearLease(repo: Repo, id: number): void {
  rmSync(leaseFile(repo, id), { force: true });
}

export function leaseAgeMinutes(repo: Repo, id: number, now: Date = new Date()): number | undefined {
  const beat = readLease(repo, id);
  if (beat === undefined) return undefined;
  return Math.max(0, Math.floor((now.getTime() - beat.getTime()) / 60_000));
}

export function isStale(repo: Repo, id: number, now: Date = new Date()): boolean {
  const age = leaseAgeMinutes(repo, id, now);
  return age === undefined || age >= repo.config.leaseMinutes;
}

function bypassFile(repo: Repo): string {
  return join(repo.stateDir, 'bypass.json');
}

export function readBypass(repo: Repo): Bypass | undefined {
  const parsed = BypassSchema.safeParse(readJson(bypassFile(repo)));
  return parsed.success ? parsed.data : undefined;
}

export function writeBypass(repo: Repo, bypass: Bypass): void {
  ensure(repo.stateDir);
  writeFileSync(bypassFile(repo), JSON.stringify(bypass));
}

export function clearBypass(repo: Repo): void {
  rmSync(bypassFile(repo), { force: true });
}

export function bypassActive(repo: Repo, session: string | undefined, now: Date = new Date()): boolean {
  const bypass = readBypass(repo);
  if (bypass === undefined) return false;
  if (bypass.mode === 'timed') {
    return bypass.until !== undefined && new Date(bypass.until).getTime() > now.getTime();
  }
  return session !== undefined && bypass.session === session;
}

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serializes tool-driven state changes across processes via an atomic mkdir lock. */
export async function withLock<T>(repo: Repo, fn: () => Promise<T>): Promise<T> {
  ensure(repo.stateDir);
  const lock = join(repo.stateDir, 'lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new WgError('Timed out waiting for the workgate lock.');
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
