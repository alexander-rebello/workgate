import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRepo, worktreeFrom, type TestRepo } from './helpers.js';

let repo: TestRepo;

beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => {
  repo.cleanup();
});

function add(title: string, extra: string[] = ['--kind', 'feature']): number {
  const out = repo.wgOk(['add', title, ...extra, '--json']);
  return (JSON.parse(out) as { id: number }).id;
}

describe('init', () => {
  it('writes config, todos dir and index, and commits them', () => {
    expect(existsSync(join(repo.dir, '.workgate', 'config.json'))).toBe(true);
    expect(existsSync(join(repo.dir, 'docs', 'TODO.md'))).toBe(true);
    expect(repo.git(['log', '--format=%s', '-1'])).toBe('Set up workgate');
    expect(repo.git(['status', '--porcelain'])).toBe('');
  });

  it('is idempotent', () => {
    const out = repo.wgOk(['init']);
    expect(out).toContain('already exists');
  });
});

describe('add, list, show, stats', () => {
  it('creates numbered items with template bodies and commits only item files', () => {
    repo.write('dirty.txt', 'unrelated');
    const id = add('First thing');
    expect(id).toBe(1);
    expect(repo.git(['show', '--name-only', '--format=%s', 'HEAD'])).toContain('docs/todos/0001-first-thing.md');
    expect(repo.git(['status', '--porcelain'])).toBe('?? dirty.txt');
    expect(repo.wgOk(['show', '1'])).toContain('## Goal');
  });

  it('allocates monotonically increasing ids', () => {
    expect(add('a')).toBe(1);
    expect(add('b')).toBe(2);
    expect(add('c', ['--kind', 'bug', '--sev', 'S2'])).toBe(3);
  });

  it('rejects sev on non-bugs and decisions without needs', () => {
    expect(repo.wg(['add', 'x', '--kind', 'feature', '--sev', 'S1']).code).toBe(1);
    const r = repo.wg(['add', 'x', '--kind', 'decision']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--needs');
  });

  it('computes blocked/open/total with total including closed items', () => {
    add('a');
    add('b');
    repo.wgOk(['add', 'ask', '--kind', 'decision', '--needs', 'pick one']);
    expect(repo.wgOk(['stats'])).toBe('1/2/3');
    repo.wgOk(['done', '3', '--outcome', 'picked', '--no-report']);
    expect(repo.wgOk(['stats'])).toBe('0/2/3');
  });

  it('filters list by status and searches text', () => {
    add('alpha item');
    add('beta item');
    expect(repo.wgOk(['list', '--text', 'alpha'])).toContain('alpha item');
    expect(repo.wgOk(['list', '--text', 'alpha'])).not.toContain('beta');
    expect(repo.wgOk(['find', 'BETA'])).toContain('beta item');
  });

  it('orders next by bug severity first and respects dependencies', () => {
    const f = add('feature work');
    add('minor bug', ['--kind', 'bug', '--sev', 'S3']);
    add('major bug', ['--kind', 'bug', '--sev', 'S1']);
    repo.wgOk(['add', 'later', '--kind', 'feature', '--after', String(f)]);
    const lines = repo.wgOk(['next']).split('\n');
    expect(lines[0]).toContain('major bug');
    expect(lines[1]).toContain('minor bug');
    expect(lines.join('\n')).not.toContain('later');
  });
});

describe('claim, release, block', () => {
  it('claims into a worktree and marks the item active', () => {
    const id = add('Do work');
    const out = repo.wgOk(['claim', String(id)]);
    const wt = worktreeFrom(out);
    expect(existsSync(wt)).toBe(true);
    expect(repo.wgOk(['show', String(id)])).toContain('[active]');
    expect(repo.wg(['claim', String(id)]).err).toContain('already active');
  });

  it('refuses to claim items with open dependencies', () => {
    const a = add('first');
    repo.wgOk(['add', 'second', '--kind', 'feature', '--after', String(a)]);
    expect(repo.wg(['claim', '2']).err).toContain('waits on #1');
  });

  it('release returns the item to todo and claim reuses the branch', () => {
    const id = add('Reusable');
    const wt = worktreeFrom(repo.wgOk(['claim', String(id)]));
    repo.write('f.txt', 'x', wt);
    repo.wgOk(['checkpoint', 'wip'], wt);
    repo.wgOk(['release', String(id)]);
    expect(repo.wgOk(['show', String(id)])).toContain('[todo]');
    const again = worktreeFrom(repo.wgOk(['claim', String(id)]));
    expect(again).toBe(wt);
    expect(existsSync(join(again, 'f.txt'))).toBe(true);
  });

  it('block and unblock record the answer and restore the state', () => {
    const id = add('Needs answer');
    repo.wgOk(['block', String(id), '--needs', 'which provider?']);
    expect(repo.wgOk(['stats'])).toBe('1/0/1');
    expect(repo.wgOk(['list', '--status', 'blocked'])).toContain('which provider?');
    repo.wgOk(['unblock', String(id), 'use provider A']);
    const shown = repo.wgOk(['show', String(id)]);
    expect(shown).toContain('[todo]');
    expect(shown).toContain('use provider A');
  });
});

describe('done', () => {
  const passing = { gates: [{ name: 'check', command: 'node -e "process.exit(0)"' }] };

  it('rebases, merges, closes the item, appends the report and cleans up', () => {
    repo.setConfig({ ...passing, reportFile: 'docs/REPORT.md' });
    const id = add('Ship it');
    const wt = worktreeFrom(repo.wgOk(['claim', String(id)]));
    repo.write('feature.txt', 'hello', wt);
    const out = repo.wgOk(['done', String(id), '--outcome', 'added feature', '--report', 'Users can now see the feature'], wt);
    expect(out).toContain('merged');
    expect(repo.read('feature.txt')).toBe('hello');
    expect(existsSync(wt)).toBe(false);
    expect(repo.git(['branch', '--list', '1-*'])).toBe('');
    expect(repo.wgOk(['show', '1'])).toContain('[done]');
    expect(repo.read('docs/REPORT.md')).toMatch(/- \d{4}-\d{2}-\d{2} — Users can now see the feature \(#1\)/);
    expect(repo.git(['log', '--format=%s', '-1'])).toContain('Merge 1-ship-it');
    expect(repo.git(['status', '--porcelain'])).toBe('');
    expect(repo.wgOk(['doctor'])).toContain('No problems');
  });

  it('works from the id alone when run inside the worktree', () => {
    repo.setConfig(passing);
    const id = add('Implicit id');
    const wt = worktreeFrom(repo.wgOk(['claim', String(id)]));
    repo.write('x.txt', 'x', wt);
    repo.wgOk(['done', '--outcome', 'ok', '--no-report'], wt);
    expect(repo.wgOk(['show', String(id)])).toContain('[done]');
  });

  it('requires either --report or --no-report', () => {
    repo.setConfig(passing);
    const id = add('Needs report flag');
    const wt = worktreeFrom(repo.wgOk(['claim', String(id)]));
    repo.write('x.txt', 'x', wt);
    expect(repo.wg(['done', String(id), '--outcome', 'ok'], wt).err).toContain('--report');
  });

  it('aborts and merges nothing when a gate fails', () => {
    repo.setConfig({ gates: [{ name: 'broken', command: 'echo boom && exit 3' }] });
    const id = add('Gate fails');
    const wt = worktreeFrom(repo.wgOk(['claim', String(id)]));
    repo.write('f.txt', 'x', wt);
    const r = repo.wg(['done', String(id), '--outcome', 'o', '--no-report'], wt);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Gate "broken" failed');
    expect(r.err).toContain('boom');
    expect(existsSync(join(repo.dir, 'f.txt'))).toBe(false);
    expect(repo.wgOk(['show', String(id)])).toContain('[active]');
    expect(existsSync(wt)).toBe(true);
  });

  it('refuses when the main checkout has uncommitted tracked changes', () => {
    repo.setConfig(passing);
    const id = add('Dirty main');
    const wt = worktreeFrom(repo.wgOk(['claim', String(id)]));
    repo.write('f.txt', 'x', wt);
    repo.write('README.md', 'edited\n');
    const r = repo.wg(['done', String(id), '--outcome', 'o', '--no-report'], wt);
    expect(r.err).toContain('uncommitted changes');
    expect(repo.wgOk(['show', String(id)])).toContain('[active]');
  });

  it('enforces attestations against the diff', () => {
    repo.setConfig({
      ...passing,
      attestations: [
        { name: 'docs', description: 'docs updated', watch: ['src/**'], require: ['docs/rules/**'] },
      ],
    });
    const id = add('Attest');
    const wt = worktreeFrom(repo.wgOk(['claim', String(id)]));
    repo.write('src/a.ts', 'export {}', wt);
    const base = ['done', String(id), '--outcome', 'o', '--no-report'];
    expect(repo.wg(base, wt).err).toContain('Missing --attest docs');
    expect(repo.wg([...base, '--attest', 'docs=n/a'], wt).err).toContain('inconsistent');
    expect(repo.wg([...base, '--attest', 'docs=ok'], wt).err).toContain('no file matching');
    repo.write('docs/rules/a.md', 'rule', wt);
    expect(repo.wg([...base, '--attest', 'docs=ok'], wt).code).toBe(0);
    expect(repo.wgOk(['show', String(id)])).toBeDefined();
  });

  it('closes decision items directly with an outcome', () => {
    repo.wgOk(['add', 'Which db?', '--kind', 'decision', '--needs', 'pick a db']);
    repo.wgOk(['done', '1', '--outcome', 'Postgres', '--no-report']);
    expect(repo.wgOk(['show', '1'])).toContain('[done]');
  });

  it('rejects done for unclaimed non-decision items', () => {
    const id = add('Not claimed');
    expect(repo.wg(['done', String(id), '--outcome', 'o', '--no-report']).err).toContain('Claim it first');
  });

  it('reports rebase conflicts and finishes after they are resolved', () => {
    repo.setConfig(passing);
    repo.write('shared.txt', 'base\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'add shared']);
    const id = add('Conflicting');
    const wt = worktreeFrom(repo.wgOk(['claim', String(id)]));
    repo.write('shared.txt', 'from branch\n', wt);
    repo.write('shared.txt', 'from main\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'main edit']);
    const base = ['done', String(id), '--outcome', 'o', '--no-report'];
    const first = repo.wg(base, wt);
    expect(first.code).toBe(1);
    expect(first.err).toContain('shared.txt');
    writeFileSync(join(wt, 'shared.txt'), 'resolved\n');
    repo.wgOk(['sync', String(id), '--continue']);
    repo.wgOk(base, wt);
    expect(repo.read('shared.txt')).toBe('resolved\n');
    expect(repo.wgOk(['show', String(id)])).toContain('[done]');
  });
});

describe('drop, verify, review, report', () => {
  it('drop refuses unmerged commits without --force and removes the worktree with it', () => {
    const id = add('Abandon');
    const wt = worktreeFrom(repo.wgOk(['claim', String(id)]));
    repo.write('f.txt', 'x', wt);
    repo.wgOk(['checkpoint', 'wip'], wt);
    expect(repo.wg(['drop', String(id), '--reason', 'no longer needed']).err).toContain('unmerged');
    repo.wgOk(['drop', String(id), '--reason', 'no longer needed', '--force']);
    expect(existsSync(wt)).toBe(false);
    expect(repo.wgOk(['show', String(id)])).toContain('[dropped]');
  });

  it('review lists unverified done items until verified', () => {
    repo.wgOk(['add', 'q', '--kind', 'decision', '--needs', 'x']);
    repo.wgOk(['done', '1', '--outcome', 'answered', '--report', 'A decision was made']);
    expect(repo.wgOk(['review'])).toContain('answered');
    expect(repo.wgOk(['report'])).toContain('A decision was made');
    repo.wgOk(['verify', '1']);
    expect(repo.wgOk(['review'])).toContain('Nothing to review');
  });
});

describe('stale detection and doctor', () => {
  it('shows an active item as stale when its lease is old and doctor flags orphans', () => {
    const id = add('Interrupted');
    const wt = worktreeFrom(repo.wgOk(['claim', String(id)]));
    expect(repo.wgOk(['list'])).not.toContain('STALE');
    const lease = join(repo.dir, '.git', 'workgate', 'leases', `${id}.json`);
    writeFileSync(lease, JSON.stringify({ heartbeat: new Date(Date.now() - 3 * 3600_000).toISOString() }));
    expect(repo.wgOk(['list'])).toContain('STALE');
    const resumed = repo.wgOk(['resume', String(id)]);
    expect(resumed).toContain(wt);
    expect(repo.wgOk(['list'])).not.toContain('STALE');
    repo.git(['worktree', 'remove', '--force', wt]);
    const r = repo.wg(['doctor']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('worktree/branch');
    expect(JSON.parse(readFileSync(lease, 'utf8')) as unknown).toBeDefined();
  });

  it('flags invalid item files', () => {
    add('ok');
    repo.write('docs/todos/0002-bad.md', '---\nid: 2\ntitle: bad\nkind: feature\nstatus: done\ncreated: 2026-01-01\n---\n');
    const r = repo.wg(['doctor']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('done items require outcome');
  });
});
