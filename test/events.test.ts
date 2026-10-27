import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRepo, worktreeFrom, type TestRepo } from './helpers.js';

let repo: TestRepo | undefined;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

interface HookPayload {
  event: string;
  item: { id: number; status: string; refs?: Record<string, string>; file: string };
}

function captureHook(r: TestRepo, on: string[]): (n: number) => HookPayload {
  const out = join(r.root, 'hook');
  r.setConfig({
    hooks: [{ on, command: `n=$(ls "${out}"* 2>/dev/null | wc -l | tr -d ' '); cat > "${out}$n.json"; echo "hook says hi"` }],
  });
  return (n) => JSON.parse(readFileSync(`${out}${n}.json`, 'utf8')) as HookPayload;
}

describe('refs', () => {
  it('stores refs given with --ref and returns them in json', () => {
    repo = makeRepo();
    const out = repo.wgOk(['add', 'Linked', '--kind', 'bug', '--ref', 'taiga=ERP-12', '--ref', 'jira=X-1', '--json']);
    const item = JSON.parse(out) as { refs: Record<string, string> };
    expect(item.refs).toEqual({ taiga: 'ERP-12', jira: 'X-1' });
    expect(repo.read('docs/todos/0001-linked.md')).toContain('refs:\n  taiga: ERP-12');
  });

  it('rejects invalid ref keys and empty values', () => {
    repo = makeRepo();
    expect(repo.wg(['add', 'x', '--kind', 'bug', '--ref', 'Bad Key=1']).code).not.toBe(0);
    expect(repo.wg(['add', 'x', '--kind', 'bug', '--ref', 'taiga=']).code).not.toBe(0);
  });
});

describe('event hooks', () => {
  it('runs on add, claim and done with the item as JSON on stdin and prints its output', () => {
    repo = makeRepo();
    const payload = captureHook(repo, ['add', 'claim', 'done']);
    const added = repo.wgOk(['add', 'Thing', '--kind', 'feature', '--ref', 'taiga=ERP-1']);
    expect(added).toContain('hook says hi');
    expect(payload(0)).toMatchObject({ event: 'add', item: { id: 1, status: 'todo', refs: { taiga: 'ERP-1' } } });

    const claimed = repo.wgOk(['claim', '1']);
    expect(payload(1)).toMatchObject({ event: 'claim', item: { id: 1, status: 'active' } });
    expect(claimed).toContain('hook says hi');

    const wt = worktreeFrom(claimed);
    repo.write('feature.txt', 'x', wt);
    const done = repo.wgOk(['done', '1', '--outcome', 'did it', '--no-report']);
    expect(done).toContain('hook says hi');
    expect(payload(2)).toMatchObject({ event: 'done', item: { id: 1, status: 'done' } });
  });

  it('only runs for configured events', () => {
    repo = makeRepo();
    captureHook(repo, ['done']);
    expect(repo.wgOk(['add', 'Thing', '--kind', 'feature'])).not.toContain('hook says hi');
  });

  it('runs on block and drop', () => {
    repo = makeRepo();
    const payload = captureHook(repo, ['block', 'drop']);
    repo.wgOk(['add', 'Thing', '--kind', 'feature']);
    repo.wgOk(['block', '1', '--needs', 'answer']);
    expect(payload(0)).toMatchObject({ event: 'block', item: { status: 'blocked' } });
    repo.wgOk(['drop', '1', '--reason', 'no']);
    expect(payload(1)).toMatchObject({ event: 'drop', item: { status: 'dropped' } });
  });

  it('a failing hook warns but does not fail the command', () => {
    repo = makeRepo({ hooks: [{ on: ['add'], command: 'echo broken >&2; exit 3' }] });
    const r = repo.wg(['add', 'Thing', '--kind', 'feature']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Created #1');
    expect(r.err).toMatch(/hook .*exit(ed)? (code )?3/i);
    expect(r.err).toContain('broken');
  });

  it('kills a hook that exceeds its timeout, including its children, and warns', () => {
    repo = makeRepo();
    const marker = join(repo.root, 'survived');
    repo.setConfig({ hooks: [{ on: ['add'], timeoutSeconds: 1, command: `(sleep 3; touch "${marker}") & sleep 30` }] });
    const started = Date.now();
    const r = repo.wg(['add', 'Thing', '--kind', 'feature']);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/timed out after 1s/);
    spawnSync('sleep', ['4']);
    expect(existsSync(marker)).toBe(false);
  });

  it('sends hook output to stderr with --json so stdout stays parseable', () => {
    repo = makeRepo();
    captureHook(repo, ['add']);
    const r = repo.wg(['add', 'Thing', '--kind', 'feature', '--json']);
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.out) as unknown).not.toThrow();
    expect(r.err).toContain('hook says hi');
  });

  it('rejects unknown events in config', () => {
    repo = makeRepo();
    repo.setConfig({ hooks: [{ on: ['explode'], command: 'true' }] });
    expect(repo.wg(['list']).code).not.toBe(0);
  });
});
