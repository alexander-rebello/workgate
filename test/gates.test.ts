import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WG, makeRepo, worktreeFrom, type TestRepo } from './helpers.js';

let repo: TestRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

interface Async {
  code: number;
  out: string;
  err: string;
}

function wgAsync(r: TestRepo, args: string[]): Promise<Async> {
  return new Promise((resolve) => {
    const child = spawn('node', [WG, ...args], { cwd: r.dir });
    child.stdin.end();
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('close', (code) => {
      resolve({ code: code ?? 1, out, err });
    });
  });
}

/** A gate that records when it starts and ends, so tests can see whether two runs overlapped. */
function recordingGate(r: TestRepo, seconds: number): { config: Record<string, unknown>; events: () => string[] } {
  const log = join(r.root, 'gate-events.log');
  writeFileSync(log, '');
  return {
    config: { gates: [{ name: 'slow', command: `echo start >> "${log}"; sleep ${seconds}; echo end >> "${log}"` }] },
    events: () => readFileSync(log, 'utf8').split('\n').filter((l) => l !== ''),
  };
}

function claimWithChange(r: TestRepo, title: string, file: string): number {
  const id = Number(/#(\d+)/.exec(r.wgOk(['add', title, '--kind', 'feature']))?.[1]);
  const wt = worktreeFrom(r.wgOk(['claim', String(id)]));
  r.write(file, `${title}\n`, wt);
  return id;
}

const done = (r: TestRepo, id: number): Promise<Async> => wgAsync(r, ['done', String(id), '--outcome', 'x', '--no-report']);

/** True while pid is a live process; a zombie (killed, waiting to be reaped by init) counts as gone. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().startsWith('Z');
}

function occupySlot(r: TestRepo, pid: number, id: number): void {
  const dir = join(r.dir, '.git', 'workgate', 'gates', 'slot-0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid, id, started: new Date().toISOString() }));
}

describe('gate slots', () => {
  it('runs the gates of parallel wg done calls one at a time and merges both', async () => {
    repo = makeRepo();
    const gate = recordingGate(repo, 1);
    repo.setConfig(gate.config);
    const a = claimWithChange(repo, 'First', 'a.txt');
    const b = claimWithChange(repo, 'Second', 'b.txt');

    const results = await Promise.all([done(repo, a), done(repo, b)]);
    expect(results.map((r) => r.code)).toEqual([0, 0]);
    const events = gate.events();
    // The second merge finds the integration branch moved and gates again: three runs, never overlapping.
    expect(events).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);
    expect(results.map((r) => r.err).join('\n')).toContain('waiting for a gate slot');
    expect(results.map((r) => r.out).join('\n')).toContain('moved while the gates ran');
    expect(repo.wgOk(['list', '--status', 'done'])).toContain('Second');
    expect(repo.git(['show', 'HEAD:a.txt'])).toBe('First');
    expect(repo.git(['show', 'HEAD:b.txt'])).toBe('Second');
    expect(repo.wgOk(['doctor'])).toContain('No problems');
  }, 60_000);

  it('lets gateConcurrency gate runs overlap', async () => {
    repo = makeRepo();
    const gate = recordingGate(repo, 2);
    repo.setConfig({ ...gate.config, gateConcurrency: 2 });
    const a = claimWithChange(repo, 'First', 'a.txt');
    const b = claimWithChange(repo, 'Second', 'b.txt');
    const results = await Promise.all([done(repo, a), done(repo, b)]);
    expect(results.map((r) => r.code)).toEqual([0, 0]);
    expect(gate.events().slice(0, 2)).toEqual(['start', 'start']);
  }, 60_000);

  it('gives up without merging when no slot frees up in time', async () => {
    repo = makeRepo();
    repo.setConfig({ ...recordingGate(repo, 0).config, gateWaitMinutes: 0.03 });
    const id = claimWithChange(repo, 'Waits', 'w.txt');
    occupySlot(repo, process.pid, 99);
    const before = repo.git(['rev-parse', 'HEAD']);
    const r = await done(repo, id);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('still busy');
    expect(r.err).toContain('#99');
    expect(repo.git(['rev-parse', 'HEAD'])).toBe(before);
    expect(repo.wgOk(['list', '--status', 'active'])).toContain('Waits');
  }, 30_000);

  it('reclaims a slot whose process is gone', async () => {
    repo = makeRepo();
    repo.setConfig(recordingGate(repo, 0).config);
    const id = claimWithChange(repo, 'Reclaims', 'r.txt');
    occupySlot(repo, 2147483646, 98);
    const r = await done(repo, id);
    expect(r.code).toBe(0);
    expect(repo.wgOk(['list', '--status', 'done'])).toContain('Reclaims');
  }, 30_000);

  it('stops the gate command and frees the slot when wg done is interrupted', async () => {
    repo = makeRepo();
    const pidFile = join(repo.root, 'gate.pid');
    repo.setConfig({ gates: [{ name: 'hang', command: `echo $$ > "${pidFile}"; sleep 60` }] });
    const id = claimWithChange(repo, 'Interrupted', 'i.txt');
    const child = spawn('node', [WG, 'done', String(id), '--outcome', 'x', '--no-report'], { cwd: repo.dir });
    child.stdin.end();
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const gatePid = Number(readFileSync(pidFile, 'utf8').trim());
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(running(gatePid)).toBe(false);
    expect(existsSync(join(repo.dir, '.git', 'workgate', 'gates', 'slot-0'))).toBe(false);
    expect(repo.wgOk(['list', '--status', 'active'])).toContain('Interrupted');
  }, 30_000);

  it('does not hold the repository lock while the gates run', async () => {
    repo = makeRepo();
    repo.setConfig(recordingGate(repo, 4).config);
    const id = claimWithChange(repo, 'Slow', 's.txt');
    const pending = done(repo, id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const started = Date.now();
    const add = await wgAsync(repo, ['add', 'Meanwhile', '--kind', 'feature']);
    expect(add.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(2500);
    expect((await pending).code).toBe(0);
  }, 30_000);
});
