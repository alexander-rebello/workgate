import { activeInfo, planProgress } from './derive.js';
import type { Item, Repo } from './types.js';

export function rulesText(repo: Repo): string {
  const c = repo.config;
  const gates = c.gates.length === 0 ? 'none configured' : c.gates.map((g) => g.name).join(', ');
  const attest = c.attestations.length === 0
    ? ''
    : ` Also pass ${c.attestations.map((a) => `--attest ${a.name}=ok|n/a|unchanged`).join(' ')} (${c.attestations.map((a) => `${a.name}: ${a.description}`).join('; ')}). If the required files already cover the change, answer unchanged and add --attest-reason <name>="<why>"; never edit a file just to satisfy the check.`;
  return [
    'Workgate is active in this repository. Work items are files in ' + c.todosDir + '/; the index ' + c.indexFile + ' is generated.',
    '- Anything that changes files must belong to an item. Read-only questions need none.',
    `- No item yet? Run: wg add "<title>" --kind bug|feature|rework|decision   then: wg claim <id>. Claim prints a worktree path; edit files only inside it.`,
    '- Keep the plan as a checklist in the item body: write it with wg body --set (reads stdin), tick steps with wg plan check <n...> (wg plan lists them numbered). Item files and the index are read-only for you.',
    '- Save progress with: wg checkpoint "<message>". Mutating git (commit, merge, rebase, push, branch, worktree, reset, stash, checkout) is denied; read-only git is fine.',
    `- Finish with: wg done <id> --outcome "<what changed>" (--report "<plain sentence for the owner>" | --no-report).${attest} It rebases, runs the gates (${gates}), merges into ${c.integrationBranch} and cleans up.`,
    '- Rebase conflicts: resolve the files, then wg sync <id> --continue (or --abort), then wg done again.',
    '- Blocked on the owner (decision, information, approval, access)? Run: wg block <id> --needs "<exactly what you need>" and tell the owner.',
    '- Edits to item files and the index are denied everywhere, in worktrees too; always go through wg.',
    '- The owner can skip this flow for one prompt by starting it with [quick]. You cannot enable that yourself.',
  ].join('\n');
}

export function digestText(repo: Repo, items: readonly Item[]): string {
  const lines: string[] = [];
  const blocked = items.filter((i) => i.meta.status === 'blocked');
  if (blocked.length > 0) {
    lines.push(`Waiting on the owner (${blocked.length}):`);
    for (const item of blocked.slice(0, 5)) lines.push(`- #${item.meta.id} ${item.meta.title}: ${item.meta.needs ?? ''}`);
    if (blocked.length > 5) lines.push(`- ... ${blocked.length - 5} more (wg list --status blocked)`);
  }
  const stale = items
    .filter((i) => i.meta.status === 'active')
    .map((i) => ({ item: i, info: activeInfo(repo, i) }))
    .filter((x) => x.info.stale);
  if (stale.length > 0) {
    lines.push(`Stale active items (${stale.length}); resume with wg resume <id> or give up with wg release <id>:`);
    for (const { item, info } of stale.slice(0, 5)) {
      const age = info.ageMinutes === undefined ? 'no heartbeat' : `idle ${info.ageMinutes}m`;
      lines.push(`- #${item.meta.id} ${item.meta.title} (${age})`);
    }
  }
  return lines.join('\n');
}

export function currentItemText(item: Item): string {
  const progress = planProgress(item.body);
  const plan = progress.total === 0 ? 'no plan checklist yet' : `plan ${progress.done}/${progress.total}`;
  return `This working directory belongs to active item #${item.meta.id} "${item.meta.title}" (${plan}).`;
}
