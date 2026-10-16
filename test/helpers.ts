import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const WG = resolve(import.meta.dirname, '..', 'bin', 'wg');

export interface WgResult {
  code: number;
  out: string;
  err: string;
}

export interface TestRepo {
  root: string;
  dir: string;
  wg: (args: string[], cwd?: string, input?: string) => WgResult;
  wgOk: (args: string[], cwd?: string) => string;
  git: (args: string[], cwd?: string) => string;
  write: (rel: string, content: string, cwd?: string) => void;
  read: (rel: string, cwd?: string) => string;
  setConfig: (patch: Record<string, unknown>) => void;
  cleanup: () => void;
}

export function makeRepo(config: Record<string, unknown> = {}): TestRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wg-test-')));
  const dir = join(root, 'repo');
  mkdirSync(dir);
  const git = (args: string[], cwd: string = dir): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'test']);
  git(['config', 'user.email', 'dev@example.com']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);

  const wg = (args: string[], cwd: string = dir, input?: string): WgResult => {
    const result = spawnSync('node', [WG, ...args], { cwd, encoding: 'utf8', input: input ?? '' });
    return { code: result.status ?? 1, out: result.stdout.trim(), err: result.stderr.trim() };
  };
  const wgOk = (args: string[], cwd: string = dir): string => {
    const r = wg(args, cwd);
    if (r.code !== 0) throw new Error(`wg ${args.join(' ')} failed (${r.code}): ${r.err}\n${r.out}`);
    return r.out;
  };

  wgOk(['init']);
  const repo: TestRepo = {
    root,
    dir,
    wg,
    wgOk,
    git,
    write: (rel, content, cwd = dir) => {
      const file = join(cwd, rel);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, content);
    },
    read: (rel, cwd = dir) => readFileSync(join(cwd, rel), 'utf8'),
    setConfig: (patch) => {
      const file = join(dir, '.workgate', 'config.json');
      const current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2));
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'config']);
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
  if (Object.keys(config).length > 0) repo.setConfig(config);
  return repo;
}

export function worktreeFrom(output: string): string {
  const m = /^worktree: (.+)$/m.exec(output);
  if (m?.[1] === undefined) throw new Error(`no worktree in output: ${output}`);
  return m[1];
}
