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

const GateSlotSchema = z.object({ pid: z.number().int(), id: z.number().int(), started: z.string() });
type GateSlot = z.infer<typeof GateSlotSchema>;

/** A slot whose owner file never appeared belongs to a process that died between mkdir and write. */
const GATE_SLOT_UNOWNED_STALE_MS = 30_000;
/** Guards against a recycled pid keeping a slot forever. */
const GATE_SLOT_MAX_MS = 6 * 60 * 60_000;
const GATE_POLL_MS = 1_000;
const GATE_NOTICE_EVERY_MS = 60_000;

export interface GateHolder {
  id: number;
  minutes: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readSlot(dir: string): GateSlot | undefined {
  try {
    const parsed = GateSlotSchema.safeParse(JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function slotStale(dir: string): boolean {
  const owner = readSlot(dir);
  if (owner === undefined) {
    try {
      return Date.now() - statSync(dir).mtimeMs > GATE_SLOT_UNOWNED_STALE_MS;
    } catch {
      return true;
    }
  }
  return !pidAlive(owner.pid) || Date.now() - new Date(owner.started).getTime() > GATE_SLOT_MAX_MS;
}

function gateHolders(root: string, limit: number): GateHolder[] {
  const holders: GateHolder[] = [];
  for (let i = 0; i < limit; i++) {
    const owner = readSlot(join(root, `slot-${i}`));
    if (owner !== undefined) {
      holders.push({ id: owner.id, minutes: Math.floor((Date.now() - new Date(owner.started).getTime()) / 60_000) });
    }
  }
  return holders;
}

function describeHolders(holders: readonly GateHolder[]): string {
  return holders.length === 0 ? 'starting up' : holders.map((h) => `#${h.id} for ${h.minutes}m`).join(', ');
}

export interface GateSlotOptions {
  /** Called when the call has to wait, and again every minute while it waits. */
  onWait?: (holders: readonly GateHolder[]) => void;
  /** Called on SIGINT/SIGTERM/SIGHUP while the slot is held, before the slot is freed and the process exits. */
  onAbort?: () => void;
}

/**
 * Runs fn while holding one of `gateConcurrency` gate slots, so heavy gate commands (builds, type checks,
 * test suites) from parallel `wg done` calls do not run all at once. Waits up to `gateWaitMinutes`.
 * Slots are directories under the state dir owned by a pid; a slot whose process is gone is reclaimed.
 */
export async function withGateSlot<T>(repo: Repo, id: number, options: GateSlotOptions, fn: () => Promise<T>): Promise<T> {
  const limit = repo.config.gateConcurrency;
  const root = join(repo.stateDir, 'gates');
  ensure(root);
  const deadline = Date.now() + repo.config.gateWaitMinutes * 60_000;
  let nextNotice = 0;
  let slot: string | undefined;
  while (slot === undefined) {
    for (let i = 0; i < limit && slot === undefined; i++) {
      const dir = join(root, `slot-${i}`);
      try {
        mkdirSync(dir);
        writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, id, started: new Date().toISOString() }));
        slot = dir;
      } catch {
        if (slotStale(dir)) {
          rmSync(dir, { recursive: true, force: true });
          i--;
        }
      }
    }
    if (slot !== undefined) break;
    const holders = gateHolders(root, limit);
    if (Date.now() > deadline) {
      throw new WgError(
        `All ${limit} gate slot(s) are still busy (${describeHolders(holders)}) after ${repo.config.gateWaitMinutes}m. Nothing was merged; run wg done again.`,
      );
    }
    if (Date.now() >= nextNotice) {
      options.onWait?.(holders);
      nextNotice = Date.now() + GATE_NOTICE_EVERY_MS;
    }
    await sleep(GATE_POLL_MS);
  }
  const held = slot;
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onSignal = (signal: NodeJS.Signals): void => {
    options.onAbort?.();
    rmSync(held, { recursive: true, force: true });
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  for (const s of signals) process.on(s, onSignal);
  try {
    return await fn();
  } finally {
    for (const s of signals) process.off(s, onSignal);
    rmSync(held, { recursive: true, force: true });
  }
}
