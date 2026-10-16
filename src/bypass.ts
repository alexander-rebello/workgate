import { relative } from 'node:path';
import { WgError } from './errors.js';
import { commitOnly, currentBranch, git, headSha } from './git.js';
import { writeIndex } from './indexgen.js';
import { createItem, loadItems, nextId, todayIso } from './items.js';
import { clearBypass, readBypass, withLock, writeBypass } from './state.js';
import type { Repo } from './types.js';

export function parseDuration(text: string): number {
  const m = /^(\d+)\s*(m|h)$/.exec(text.trim());
  if (m === null) throw new WgError('Duration must look like 30m or 2h.');
  const n = Number(m[1]);
  return n * (m[2] === 'h' ? 60 : 1) * 60_000;
}

export async function startBypass(
  repo: Repo,
  mode: { kind: 'prompt'; session: string } | { kind: 'timed'; ms: number },
  now: Date = new Date(),
): Promise<void> {
  const existing = readBypass(repo);
  if (existing !== undefined) return;
  const startHead = await headSha(repo.mainRoot);
  writeBypass(
    repo,
    mode.kind === 'prompt'
      ? { mode: 'prompt', session: mode.session, startHead, startedAt: now.toISOString() }
      : {
          mode: 'timed',
          until: new Date(now.getTime() + mode.ms).toISOString(),
          startHead,
          startedAt: now.toISOString(),
        },
  );
}

/** Ends any bypass and records commits made during it as a closed item so the list stays complete. */
export async function endBypass(repo: Repo): Promise<string | undefined> {
  const bypass = readBypass(repo);
  if (bypass === undefined) return undefined;
  clearBypass(repo);
  const head = await headSha(repo.mainRoot);
  if (head === bypass.startHead) return undefined;
  const branch = await currentBranch(repo.mainRoot);
  if (branch !== repo.config.integrationBranch) {
    return `Bypass ended on branch "${branch}"; the quick change was not recorded as an item.`;
  }
  const log = await git(repo.mainRoot, ['log', '--format=%h %s', `${bypass.startHead}..${head}`]).catch(() => '');
  const lines = log === '' ? [] : log.split('\n');
  if (lines.length === 0) return undefined;
  const firstSubject = (lines[lines.length - 1] ?? '').replace(/^\S+\s+/, '');
  const title = `Quick change: ${firstSubject}${lines.length > 1 ? ` (+${lines.length - 1} more)` : ''}`.slice(0, 120);
  return withLock(repo, async () => {
    const items = loadItems(repo);
    const id = nextId(items);
    const body = [
      'Recorded automatically after a bypass (the owner skipped the item flow for this change).',
      '',
      '## Commits',
      '',
      ...lines.map((l) => `- ${l}`),
    ].join('\n');
    const item = createItem(
      repo,
      {
        id,
        title,
        kind: 'rework',
        status: 'done',
        created: todayIso(),
        closed: todayIso(),
        outcome: 'Quick change made under an owner bypass; not planned or gated.',
      },
      body,
    );
    const indexRel = writeIndex(repo, loadItems(repo));
    await commitOnly(
      repo.mainRoot,
      [relative(repo.mainRoot, item.file), indexRel],
      `wg: record bypass #${id}${repo.config.commitSuffix}\n\nTodo: #${id}`,
    );
    return `Recorded the bypass as #${id}.`;
  });
}
