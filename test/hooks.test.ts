import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WG, makeRepo, worktreeFrom, type TestRepo } from './helpers.js';

let repo: TestRepo;

beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => {
  repo.cleanup();
});

interface HookReply {
  decision?: string;
  reason?: string;
  context?: string;
  raw: string;
}

function hook(name: string, payload: Record<string, unknown>): HookReply {
  const r = spawnSync('node', [WG, 'hook', name], {
    cwd: repo.dir,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 's1', cwd: repo.dir, ...payload }),
  });
  expect(r.status).toBe(0);
  const raw = r.stdout.trim();
  if (raw === '') return { raw };
  const parsed = JSON.parse(raw) as {
    hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };
  };
  const out = parsed.hookSpecificOutput;
  return {
    raw,
    ...(out.permissionDecision === undefined ? {} : { decision: out.permissionDecision }),
    ...(out.permissionDecisionReason === undefined ? {} : { reason: out.permissionDecisionReason }),
    ...(out.additionalContext === undefined ? {} : { context: out.additionalContext }),
  };
}

const bash = (command: string, cwd = repo.dir, session = 's1'): HookReply =>
  hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command }, cwd, session_id: session });
const edit = (file: string, tool = 'Edit', session = 's1'): HookReply =>
  hook('pre-tool-use', { tool_name: tool, tool_input: { file_path: file }, session_id: session });

describe('pre-tool-use: git deny', () => {
  it('denies mutating git and allows read-only git', () => {
    expect(bash('git commit -m x').decision).toBe('deny');
    expect(bash('git commit -m x').reason).toContain('wg checkpoint');
    expect(bash('git push').decision).toBe('deny');
    expect(bash('git status').decision).toBeUndefined();
    expect(bash('git log --oneline').raw).toBe('');
    expect(bash('ls').raw).toBe('');
  });

  it('does nothing outside workgate repos', () => {
    const r = spawnSync('node', [WG, 'hook', 'pre-tool-use'], {
      cwd: repo.root,
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: repo.root }),
    });
    expect(r.stdout.trim()).toBe('');
  });

  it('blocks bypass management by the agent', () => {
    expect(bash('wg bypass 30m').decision).toBe('deny');
    expect(bash('cat .git/workgate/bypass.json').decision).toBe('deny');
  });
});

describe('pre-tool-use: write gate', () => {
  it('denies edits in the main checkout without an active item', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(edit(join(repo.dir, 'a.ts'), tool).decision).toBe('deny');
    }
    expect(edit(join(repo.dir, 'a.ts')).reason).toContain('wg claim');
  });

  it('allows edits inside an active item worktree, including new subdirectories', () => {
    repo.wgOk(['add', 'Gate', '--kind', 'feature']);
    const wt = worktreeFrom(repo.wgOk(['claim', '1']));
    expect(edit(join(wt, 'src', 'new', 'file.ts')).decision).toBeUndefined();
    expect(edit(join(repo.dir, 'a.ts')).decision).toBe('deny');
  });

  it('allows edits outside any repository', () => {
    expect(edit(join(repo.root, 'outside.txt')).raw).toBe('');
  });

  it('denies edits to workgate state', () => {
    expect(edit(join(repo.dir, '.git', 'workgate', 'bypass.json')).decision).toBe('deny');
  });
});

describe('pre-tool-use: item files are read-only for the agent', () => {
  const guarded = ['docs/todos/0001-gate.md', 'docs/TODO.md'];

  it('denies Edit/Write on item files and the index in the main checkout, a worktree and during a bypass', () => {
    repo.wgOk(['add', 'Gate', '--kind', 'feature']);
    const wt = worktreeFrom(repo.wgOk(['claim', '1']));
    for (const base of [repo.dir, wt]) {
      for (const rel of guarded) {
        const r = edit(join(base, rel));
        expect(r.decision).toBe('deny');
        expect(r.reason).toContain('wg plan');
      }
    }
    expect(edit(join(wt, 'src', 'ok.ts')).decision).toBeUndefined();
    repo.wgOk(['bypass', '30m']);
    expect(edit(join(repo.dir, 'docs/todos/0001-gate.md')).decision).toBe('deny');
  });

  it('denies shell writes to item files but allows reading them', () => {
    expect(bash('sed -i s/a/b/ docs/todos/0001-gate.md').decision).toBe('deny');
    expect(bash('echo x >> docs/TODO.md').decision).toBe('deny');
    expect(bash('rm docs/todos/0001-gate.md').decision).toBe('deny');
    expect(bash('tee docs/todos/0001-gate.md').decision).toBe('deny');
    expect(bash('bash -c "mv a docs/todos/b.md"').decision).toBe('deny');
    expect(bash('cat docs/todos/0001-gate.md').raw).toBe('');
    expect(bash('grep -rn foo docs/todos').raw).toBe('');
    expect(bash('wg plan check 1').raw).toBe('');
  });
});

describe('pre-tool-use: shell writes without an item', () => {
  it('allows but warns on shell writes in the main checkout without an active item', () => {
    for (const cmd of ['echo hi > y.txt', "sed -i '' s/a/b/ README.md", 'tee out.txt', 'rm README.md']) {
      const r = bash(cmd);
      expect(r.decision).toBeUndefined();
      expect(r.context).toContain('wg claim');
    }
  });

  it('stays quiet for reads, discarded output, paths outside the repo and inside an item worktree', () => {
    expect(bash('cat README.md > /dev/null 2>&1').raw).toBe('');
    expect(bash(`echo hi > ${join(repo.root, 'outside.txt')}`).raw).toBe('');
    repo.wgOk(['add', 'Work', '--kind', 'feature']);
    const wt = worktreeFrom(repo.wgOk(['claim', '1']));
    expect(bash('echo hi > y.txt', wt).raw).toBe('');
    expect(bash(`echo hi > ${join(repo.dir, 'y.txt')}`, wt).context).toContain('wg claim');
  });

  it('stays quiet during a bypass', () => {
    hook('user-prompt-submit', { prompt: '[quick] tiny fix' });
    expect(bash('echo hi > y.txt').raw).toBe('');
  });
});

describe('bypass via [quick] prompt', () => {
  it('opens the gate for one prompt, allows commits but not push, then records an item', () => {
    const start = hook('user-prompt-submit', { prompt: '[quick] fix the typo' });
    expect(start.context).toContain('bypass is active');
    expect(edit(join(repo.dir, 'a.ts')).raw).toBe('');
    expect(bash('git commit -m x').raw).toBe('');
    expect(bash('git push').decision).toBe('deny');
    expect(bash('wg bypass off').decision).toBe('deny');
    expect(edit(join(repo.dir, 'a.ts'), 'Edit', 'another-session').decision).toBe('deny');

    repo.write('typo.txt', 'fixed');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'Fix typo']);

    const next = hook('user-prompt-submit', { prompt: 'now something else' });
    expect(next.context).toContain('Recorded the bypass as #1');
    expect(edit(join(repo.dir, 'a.ts')).decision).toBe('deny');
    const shown = repo.wgOk(['show', '1']);
    expect(shown).toContain('[done]');
    expect(shown).toContain('Quick change: Fix typo');
    expect(repo.git(['status', '--porcelain'])).toBe('');
  });

  it('ends the bypass and records nothing when no commits were made', () => {
    hook('user-prompt-submit', { prompt: '[QUICK] look around' });
    hook('user-prompt-submit', { prompt: 'normal prompt' });
    expect(repo.wgOk(['list', '--all'])).toBe('No matching items.');
    expect(repo.wgOk(['bypass', 'status'])).toBe('No bypass active.');
  });

  it('records the bypass when the session ends', () => {
    hook('user-prompt-submit', { prompt: '[quick] tiny' });
    repo.write('t.txt', 't');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'Tiny']);
    hook('session-end', {});
    expect(repo.wgOk(['list', '--all'])).toContain('Quick change: Tiny');
  });

  it('owner timed bypass works and can be ended', () => {
    repo.wgOk(['bypass', '30m']);
    expect(edit(join(repo.dir, 'a.ts')).raw).toBe('');
    expect(repo.wgOk(['bypass', 'status'])).toContain('timed');
    repo.wgOk(['bypass', 'off']);
    expect(edit(join(repo.dir, 'a.ts')).decision).toBe('deny');
  });
});

describe('session start and prompt hooks', () => {
  it('injects rules and a digest of blocked and stale items', () => {
    repo.wgOk(['add', 'Pick a vendor', '--kind', 'decision', '--needs', 'which vendor?']);
    repo.wgOk(['add', 'Interrupted', '--kind', 'feature']);
    repo.wgOk(['claim', '2']);
    const lease = join(repo.dir, '.git', 'workgate', 'leases', '2.json');
    expect(existsSync(lease)).toBe(true);
    const r = hook('session-start', { source: 'startup' });
    expect(r.context).toContain('Workgate is active');
    expect(r.context).toContain('which vendor?');
    expect(r.context).not.toContain('Stale active');
  });

  it('reminds about the missing item on a normal prompt in the main checkout', () => {
    const r = hook('user-prompt-submit', { prompt: 'please add a button' });
    expect(r.context).toContain('no active item');
  });

  it('stays quiet on prompts inside an item worktree and keeps the lease fresh', () => {
    repo.wgOk(['add', 'Quiet', '--kind', 'feature']);
    const wt = worktreeFrom(repo.wgOk(['claim', '1']));
    const r = hook('user-prompt-submit', { prompt: 'continue', cwd: wt });
    expect(r.raw).toBe('');
    hook('post-tool-use', { tool_name: 'Bash', cwd: wt });
    expect(readdirSync(join(repo.dir, '.git', 'workgate', 'leases'))).toContain('1.json');
  });

  it('keeps the lease fresh for file tools that edit a worktree from the main checkout', () => {
    repo.wgOk(['add', 'Sub', '--kind', 'feature']);
    const wt = worktreeFrom(repo.wgOk(['claim', '1']));
    const lease = join(repo.dir, '.git', 'workgate', 'leases', '1.json');
    rmSync(lease);
    hook('post-tool-use', { tool_name: 'Bash', cwd: repo.dir });
    expect(existsSync(lease)).toBe(false);
    hook('post-tool-use', { tool_name: 'Edit', cwd: repo.dir, tool_input: { file_path: join(wt, 'src', 'new', 'a.ts') } });
    expect(existsSync(lease)).toBe(true);
  });

  it('never fails the session on malformed input', () => {
    const r = spawnSync('node', [WG, 'hook', 'pre-tool-use'], { cwd: repo.dir, encoding: 'utf8', input: 'not json' });
    expect(r.status).toBe(0);
  });
});
