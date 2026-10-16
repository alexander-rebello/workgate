import { WgError } from './errors.js';
import { run } from './exec.js';

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await run('git', args, cwd);
  if (result.code !== 0) {
    throw new WgError(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function gitOk(cwd: string, args: readonly string[]): Promise<boolean> {
  const result = await run('git', args, cwd);
  return result.code === 0;
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export async function headSha(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', 'HEAD']);
}

export async function isCleanTracked(cwd: string): Promise<boolean> {
  const out = await git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  return out === '';
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return gitOk(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
}

export interface WorktreeInfo {
  path: string;
  branch: string | undefined;
}

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']);
  const result: WorktreeInfo[] = [];
  let current: { path: string; branch: string | undefined } | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current !== undefined) result.push(current);
      current = { path: line.slice('worktree '.length), branch: undefined };
    } else if (line.startsWith('branch ') && current !== undefined) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current !== undefined) result.push(current);
  return result;
}

/** Commits exactly the given paths, ignoring any other staged or dirty files. */
export async function commitOnly(
  cwd: string,
  paths: readonly string[],
  message: string,
): Promise<void> {
  await git(cwd, ['add', '--all', '--', ...paths]);
  await git(cwd, ['commit', '--no-verify', '--only', '-m', message, '--', ...paths]);
}

export async function changedFiles(cwd: string, base: string, head: string): Promise<string[]> {
  const out = await git(cwd, ['diff', '--name-only', `${base}...${head}`]);
  return out === '' ? [] : out.split('\n');
}
