import { describe, expect, it } from 'vitest';
import { mutatingGit, shellWriteTargets, touchesProtectedState } from '../src/guard.js';

const denied = (cmd: string): string[] => mutatingGit(cmd).map((m) => m.subcommand);

describe('mutatingGit', () => {
  it.each([
    'git status',
    'git log --oneline -5',
    'git diff HEAD~1',
    'git -C /tmp/x status',
    'git -c core.pager=cat log',
    'git branch',
    'git branch -a',
    'git branch --list "feat*"',
    'git branch --show-current',
    'git worktree list',
    'git stash list',
    'git remote -v',
    'git remote show origin',
    'git config --get user.name',
    'git tag',
    'git tag -l "v*"',
    'git fetch origin',
    'git rev-parse --show-toplevel',
    'git status && git log',
    'echo "git commit is blocked"',
    'grep -r "git push" docs',
    'ls | wc -l',
    'wg done 3 --outcome "git rebase fixed" --no-report',
  ])('allows %s', (cmd) => {
    expect(denied(cmd)).toEqual([]);
  });

  it.each([
    ['git commit -m x', 'commit'],
    ['git add -A && git commit -m x', 'add'],
    ['git push origin main', 'push'],
    ['git merge feature', 'merge'],
    ['git rebase test', 'rebase'],
    ['git reset --hard HEAD~1', 'reset'],
    ['git checkout -- .', 'checkout'],
    ['git switch main', 'switch'],
    ['git branch -D foo', 'branch'],
    ['git branch newbranch', 'branch'],
    ['git worktree add ../x', 'worktree'],
    ['git worktree remove x', 'worktree'],
    ['git stash', 'stash'],
    ['git stash pop', 'stash'],
    ['git tag v1', 'tag'],
    ['git config user.name x', 'config'],
    ['git clean -fd', 'clean'],
    ['git -C ../other commit -m x', 'commit'],
    ['/usr/bin/git commit -m x', 'commit'],
    ['FOO=1 git commit -m x', 'commit'],
    ['sudo git push', 'push'],
    ['env GIT_DIR=x git commit', 'commit'],
    ['bash -c "git commit -m x"', 'commit'],
    ["sh -c 'git push'", 'push'],
    ['eval "git reset --hard"', 'reset'],
    ['echo $(git commit -m x)', 'commit'],
    ['echo "$(git push)"', 'push'],
    ['`git commit -m x`', 'commit'],
    ['(git commit -m x)', 'commit'],
    ['cd x; git commit -m y', 'commit'],
    ['true || git push', 'push'],
    ['git status | cat & git commit -m x', 'commit'],
    ['xargs git rm', 'rm'],
    ['git\\\n commit', 'commit'],
  ])('denies %s', (cmd, sub) => {
    expect(denied(cmd)).toContain(sub);
  });
});

describe('touchesProtectedState', () => {
  it('blocks bypass management and state access', () => {
    expect(touchesProtectedState('wg bypass 30m')).toBe(true);
    expect(touchesProtectedState('wg bypass off')).toBe(true);
    expect(touchesProtectedState('/x/bin/wg bypass 2h')).toBe(true);
    expect(touchesProtectedState('rm -rf .git/workgate')).toBe(true);
    expect(touchesProtectedState('cat .git/workgate/bypass.json')).toBe(true);
    expect(touchesProtectedState('wg bypass status')).toBe(false);
    expect(touchesProtectedState('wg list')).toBe(false);
  });
});

describe('shellWriteTargets', () => {
  it.each([
    ['echo hi > y.txt', ['y.txt']],
    ['echo hi >y.txt', ['y.txt']],
    ['echo hi >> log/a.txt', ['log/a.txt']],
    ['cmd 2> err.txt', ['err.txt']],
    ['cmd &> all.txt', ['all.txt']],
    ['cat > notes.md <<EOF\nhello\nEOF', ['notes.md']],
    ['printf x | tee -a a.txt b.txt', ['a.txt', 'b.txt']],
    ["sed -i '' 's/a/b/' src/x.ts", ['src/x.ts']],
    ['sed -i.bak -e s/a/b/ src/x.ts src/y.ts', ['src/x.ts', 'src/y.ts']],
    ['perl -pi -e s/a/b/ f.txt', ['f.txt']],
    ['cp -r src/a dest', ['dest']],
    ['mv a.txt b.txt', ['b.txt']],
    ['rm -f a.txt b.txt', ['a.txt', 'b.txt']],
    ['touch new.txt && mkdir -p d/e', ['new.txt', 'd/e']],
    ['dd if=/dev/zero of=blob bs=1 count=1', ['blob']],
    ['bash -c "echo x > inner.txt"', ['inner.txt']],
    ['wg add t --kind bug <<<body\nrm a.txt', ['a.txt']],
  ])('finds the targets of %s', (cmd, expected) => {
    expect(shellWriteTargets(cmd)).toEqual(expected);
  });

  it.each([
    'ls -la',
    'cat a.txt',
    'grep ">" a.txt',
    'echo "a > b"',
    'cmd > /dev/null 2>&1',
    'cmd >&2',
    'sed s/a/b/ a.txt',
    'wg add "t" --kind bug <<\'EOF\'\nfoo > bar.txt\nrm x\nEOF',
    'echo $HOME > $OUT',
  ])('finds nothing in %s', (cmd) => {
    expect(shellWriteTargets(cmd)).toEqual([]);
  });
});
