import { realpathSync } from 'node:fs';
import { Command, InvalidArgumentError, Option } from 'commander';
import { endBypass, parseDuration, startBypass } from './bypass.js';
import { computeStats, nextItems, planProgress } from './derive.js';
import { WgError } from './errors.js';
import { readStdin } from './stdin.js';
import { runHook, type HookName } from './hooks.js';
import { initRepo } from './init.js';
import { findItem, loadAll, loadItems } from './items.js';
import {
  addItem,
  blockItem,
  checkpoint,
  claimItem,
  doctor,
  doneItem,
  dropItem,
  markSteps,
  planSteps,
  readBody,
  readBodyById,
  setBody,
  setBodyById,
  releaseItem,
  requireItemForCwd,
  resumeItem,
  syncItem,
  unblockItem,
  verifyItem,
} from './ops.js';
import { resolveRepo } from './repo.js';
import { readBypass, isStale, leaseAgeMinutes } from './state.js';
import { renderStatusline } from './statusline.js';
import { installStatusline } from './statusline-install.js';
import { writeIndex } from './indexgen.js';
import { KINDS, SEVERITIES, STATUSES, type Item, type Kind, type Repo, type Severity, type Status } from './types.js';

function parseId(value: string): number {
  const id = Number(value.replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) throw new InvalidArgumentError('Expected an item id such as 12 or #12.');
  return id;
}

function parseIds(value: string): number[] {
  return value.split(',').filter((v) => v.trim() !== '').map((v) => parseId(v.trim()));
}

function collectAttest(value: string, previous: Record<string, string>): Record<string, string> {
  const eq = value.indexOf('=');
  if (eq <= 0) throw new InvalidArgumentError('Expected name=ok, name=n/a or name=unchanged.');
  return { ...previous, [value.slice(0, eq)]: value.slice(eq + 1) };
}

function collectAttestReason(value: string, previous: Record<string, string>): Record<string, string> {
  const eq = value.indexOf('=');
  if (eq <= 0) throw new InvalidArgumentError('Expected name=reason.');
  return { ...previous, [value.slice(0, eq)]: value.slice(eq + 1) };
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function summary(repo: Repo, item: Item): string {
  const m = item.meta;
  const sev = m.sev === undefined ? '' : ` ${m.sev}`;
  let extra = '';
  if (m.status === 'blocked') extra = ` - needs: ${m.needs ?? ''}`;
  if (m.status === 'active') {
    const age = leaseAgeMinutes(repo, m.id);
    extra = isStale(repo, m.id) ? ` - STALE${age === undefined ? '' : ` (${age}m idle)`} wt:${m.wt ?? ''}` : ` - wt:${m.wt ?? ''}`;
  }
  if (m.status === 'done' || m.status === 'dropped') extra = ` - ${m.closed ?? ''}`;
  return `#${m.id} [${m.status}] ${m.kind}${sev}  ${m.title}${extra}`;
}

function jsonItem(repo: Repo, item: Item): Record<string, unknown> {
  return {
    ...item.meta,
    file: item.file,
    ...(item.meta.status === 'active'
      ? { stale: isStale(repo, item.meta.id), idleMinutes: leaseAgeMinutes(repo, item.meta.id) ?? null, plan: planProgress(item.body) }
      : {}),
  };
}

async function repoForCwd(): Promise<Repo> {
  return resolveRepo(process.cwd());
}

async function resolveItemId(repo: Repo, id: number | undefined): Promise<number> {
  if (id !== undefined) return id;
  const item = await requireItemForCwd(repo, process.cwd());
  return item.meta.id;
}

// Injected by scripts/build.mjs: the bundle is also copied outside the package (statusline install), so package.json is not readable at runtime.
declare const __WG_VERSION__: string;

const program = new Command();
program
  .name('wg')
  .version(__WG_VERSION__)
  .description('File-backed work items that gate changes behind claimed items, worktrees and a verified merge flow.')
  .showHelpAfterError();

program
  .command('init')
  .description('Set up workgate in the current repository')
  .option('--branch <name>', 'integration branch (default: current branch)')
  .option('--claude-md', 'add a short workgate section to CLAUDE.md')
  .option('--no-commit', 'write files without committing')
  .action(async (opts: { branch?: string; claudeMd?: boolean; commit: boolean }) => {
    const log = await initRepo(process.cwd(), { branch: opts.branch, claudeMd: opts.claudeMd === true, commit: opts.commit });
    for (const line of log) print(line);
  });

program
  .command('add')
  .description('Create a work item')
  .argument('<title>')
  .addOption(new Option('--kind <kind>', 'bug | feature | rework | decision').choices(KINDS).makeOptionMandatory())
  .addOption(new Option('--sev <sev>', 'severity for bugs').choices(SEVERITIES))
  .option('--body <text>', 'item body; otherwise read from stdin (default: a template for the kind)')
  .option('--after <ids>', 'comma-separated ids this item depends on', parseIds)
  .option('--parent <id>', 'parent item id', parseId)
  .option('--needs <text>', 'create the item blocked, stating what the owner must provide')
  .option('--json', 'machine-readable output')
  .action(
    async (
      title: string,
      opts: { kind: Kind; sev?: Severity; body?: string; after?: number[]; parent?: number; needs?: string; json?: boolean },
    ) => {
      const repo = await repoForCwd();
      const body = opts.body ?? (process.stdin.isTTY ? undefined : await readStdin());
      const item = await addItem(repo, { title, kind: opts.kind, sev: opts.sev, body, after: opts.after, parent: opts.parent, needs: opts.needs });
      print(opts.json === true ? JSON.stringify(jsonItem(repo, item)) : `Created #${item.meta.id} (${item.meta.status}): ${item.file}`);
    },
  );

program
  .command('list')
  .description('List items (open ones by default)')
  .addOption(new Option('--status <status...>', 'filter by status').choices(STATUSES))
  .addOption(new Option('--kind <kind>', 'filter by kind').choices(KINDS))
  .option('--text <text>', 'case-insensitive search in title and body')
  .option('--all', 'include done and dropped items')
  .option('--json', 'machine-readable output')
  .action((opts: { status?: Status[]; kind?: Kind; text?: string; all?: boolean; json?: boolean }) => listAction(opts));

async function listAction(opts: { status?: Status[]; kind?: Kind; text?: string; all?: boolean; json?: boolean }): Promise<void> {
  const repo = await repoForCwd();
  const items = loadItems(repo);
  const needle = opts.text?.toLowerCase();
  const selected = items.filter((i) => {
    if (opts.status !== undefined && opts.status.length > 0) {
      if (!opts.status.includes(i.meta.status)) return false;
    } else if (opts.all !== true && (i.meta.status === 'done' || i.meta.status === 'dropped')) {
      return false;
    }
    if (opts.kind !== undefined && i.meta.kind !== opts.kind) return false;
    if (needle !== undefined && !`${i.meta.title}\n${i.body}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  if (opts.json === true) {
    print(JSON.stringify(selected.map((i) => jsonItem(repo, i))));
    return;
  }
  if (selected.length === 0) print('No matching items.');
  for (const item of selected) print(summary(repo, item));
}

program
  .command('find')
  .description('Full-text search across all items, including closed ones')
  .argument('<text>')
  .option('--json', 'machine-readable output')
  .action((text: string, opts: { json?: boolean }) => listAction({ text, all: true, ...(opts.json === true ? { json: true } : {}) }));

program
  .command('show')
  .description('Show one item')
  .argument('<id>', 'item id', parseId)
  .option('--json', 'machine-readable output')
  .action(async (id: number, opts: { json?: boolean }) => {
    const repo = await repoForCwd();
    const item = findItem(loadItems(repo), id);
    if (opts.json === true) {
      print(JSON.stringify({ ...jsonItem(repo, item), body: item.body }));
      return;
    }
    print(summary(repo, item));
    print(`file: ${item.file}`);
    if (item.body !== '') print(`\n${item.body}`);
  });

program
  .command('next')
  .description('List todo items that can be picked up now (dependencies met), bugs by severity first')
  .option('--limit <n>', 'maximum rows', (v) => Number(v), 10)
  .option('--json', 'machine-readable output')
  .action(async (opts: { limit: number; json?: boolean }) => {
    const repo = await repoForCwd();
    const picked = nextItems(loadItems(repo)).slice(0, opts.limit);
    if (opts.json === true) {
      print(JSON.stringify(picked.map((i) => jsonItem(repo, i))));
      return;
    }
    if (picked.length === 0) print('Nothing is ready to pick up.');
    for (const item of picked) print(summary(repo, item));
  });

program
  .command('stats')
  .description('Counts: blocked/open/total')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) => {
    const repo = await repoForCwd();
    const stats = computeStats(repo, loadItems(repo));
    if (opts.json === true) print(JSON.stringify(stats));
    else print(`${stats.blocked}/${stats.open}/${stats.total}`);
  });

function printClaim(result: { item: Item; worktree: string; branch: string }, json: boolean | undefined, repo: Repo): void {
  if (json === true) {
    print(JSON.stringify({ ...jsonItem(repo, result.item), worktree: result.worktree }));
    return;
  }
  print(`#${result.item.meta.id} ${result.item.meta.title}`);
  print(`branch: ${result.branch}`);
  print(`worktree: ${result.worktree}`);
}

program
  .command('claim')
  .description('Start work on a todo item: creates its branch and worktree')
  .argument('<id>', 'item id', parseId)
  .option('--json', 'machine-readable output')
  .action(async (id: number, opts: { json?: boolean }) => {
    const repo = await repoForCwd();
    printClaim(await claimItem(repo, id), opts.json, repo);
  });

program
  .command('resume')
  .description('Re-attach to an active item (for example after an interrupted session)')
  .argument('<id>', 'item id', parseId)
  .option('--json', 'machine-readable output')
  .action(async (id: number, opts: { json?: boolean }) => {
    const repo = await repoForCwd();
    const result = await resumeItem(repo, id);
    printClaim(result, opts.json, repo);
    if (opts.json !== true) print(`plan: ${result.progress.done}/${result.progress.total}`);
  });

program
  .command('release')
  .description('Return an active item to todo (the worktree is kept)')
  .argument('<id>', 'item id', parseId)
  .action(async (id: number) => {
    await releaseItem(await repoForCwd(), id);
    print(`Released #${id}.`);
  });

program
  .command('block')
  .description('Mark an item as waiting on the owner')
  .argument('<id>', 'item id', parseId)
  .requiredOption('--needs <text>', 'exactly what the owner must provide')
  .action(async (id: number, opts: { needs: string }) => {
    await blockItem(await repoForCwd(), id, opts.needs);
    print(`Blocked #${id}.`);
  });

program
  .command('unblock')
  .description('Record the owner answer and resume the item')
  .argument('<id>', 'item id', parseId)
  .argument('[answer]', 'the answer, appended to the item body')
  .action(async (id: number, answer: string | undefined) => {
    const item = await unblockItem(await repoForCwd(), id, answer);
    print(`#${id} is now ${item.meta.status}.`);
  });

program
  .command('drop')
  .description('Close an item without doing it')
  .argument('<id>', 'item id', parseId)
  .requiredOption('--reason <text>')
  .option('--force', 'discard unmerged commits')
  .action(async (id: number, opts: { reason: string; force?: boolean }) => {
    await dropItem(await repoForCwd(), id, opts.reason, opts.force === true);
    print(`Dropped #${id}.`);
  });

program
  .command('verify')
  .description('Mark a done item as verified by the owner')
  .argument('<id>', 'item id', parseId)
  .action(async (id: number) => {
    await verifyItem(await repoForCwd(), id);
    print(`Verified #${id}.`);
  });

program
  .command('review')
  .description('List done items that have not been verified yet')
  .option('--since <date>', 'only items closed on or after this date (YYYY-MM-DD)')
  .option('--json', 'machine-readable output')
  .action(async (opts: { since?: string; json?: boolean }) => {
    const repo = await repoForCwd();
    const rows = loadItems(repo).filter(
      (i) => i.meta.status === 'done' && i.meta.verified !== true && (opts.since === undefined || (i.meta.closed ?? '') >= opts.since),
    );
    if (opts.json === true) {
      print(JSON.stringify(rows.map((i) => ({ ...jsonItem(repo, i), body: i.body }))));
      return;
    }
    if (rows.length === 0) print('Nothing to review.');
    for (const item of rows) {
      print(summary(repo, item));
      print(`  outcome: ${item.meta.outcome ?? ''}`);
    }
  });

program
  .command('report')
  .description('Plain-language report lines of items closed since a date')
  .option('--since <date>', 'YYYY-MM-DD', '0000-00-00')
  .action(async (opts: { since: string }) => {
    const repo = await repoForCwd();
    const rows = loadItems(repo)
      .filter((i) => i.meta.status === 'done' && i.meta.report !== undefined && (i.meta.closed ?? '') >= opts.since)
      .sort((a, b) => (a.meta.closed ?? '').localeCompare(b.meta.closed ?? '') || a.meta.id - b.meta.id);
    if (rows.length === 0) print('No reportable items.');
    for (const i of rows) print(`- ${i.meta.closed ?? ''} - ${i.meta.report ?? ''} (#${i.meta.id})`);
  });

program
  .command('checkpoint')
  .description("Commit pending changes in the current item's worktree")
  .argument('[message]')
  .action(async (message: string | undefined) => {
    print(await checkpoint(await repoForCwd(), process.cwd(), message));
  });

program
  .command('body')
  .description("Print an item's body, or replace it from stdin with --set (default: the current worktree's item)")
  .argument('[id]', 'item id; --set with an id only works for items that were never claimed', parseId)
  .option('--set', 'replace the body with stdin')
  .action(async (id: number | undefined, opts: { set?: boolean }) => {
    const repo = await repoForCwd();
    if (opts.set === true) {
      const text = await readStdin();
      if (text.trim() === '') throw new WgError('Refusing to set an empty body; pipe the new body on stdin.');
      if (id === undefined) await setBody(repo, process.cwd(), text);
      else await setBodyById(repo, id, text);
      print('Body updated.');
    } else {
      print(id === undefined ? await readBody(repo, process.cwd()) : await readBodyById(repo, id));
    }
  });

const plan = program.command('plan').description("Show or tick the current item's plan checklist").action(async () => {
  const body = await readBody(await repoForCwd(), process.cwd());
  const steps = planSteps(body);
  if (steps.length === 0) print('No plan steps. Add "- [ ] step" lines with wg body --set.');
  for (const s of steps) print(`${s.n}. [${s.checked ? 'x' : ' '}] ${s.text}`);
});

for (const [name, checked] of [['check', true], ['uncheck', false]] as const) {
  plan
    .command(name)
    .description(`Mark plan steps ${checked ? 'done' : 'open'} by number`)
    .argument('<numbers...>', 'step numbers as listed by wg plan')
    .action(async (numbers: string[]) => {
      const nums = numbers.map((n) => Number(n));
      const progress = await markSteps(await repoForCwd(), process.cwd(), nums, checked);
      print(`Plan: ${progress.done}/${progress.total}`);
    });
}

program
  .command('sync')
  .description('Rebase an item branch onto the integration branch; resolve conflicts with --continue / --abort')
  .argument('[id]', 'item id (default: current worktree)', parseId)
  .option('--continue', 'continue after resolving conflicts')
  .option('--abort', 'abort the rebase')
  .action(async (id: number | undefined, opts: { continue?: boolean; abort?: boolean }) => {
    const repo = await repoForCwd();
    const item = findItem(loadItems(repo), await resolveItemId(repo, id));
    const mode = opts.abort === true ? 'abort' : opts.continue === true ? 'continue' : 'start';
    const result = await syncItem(repo, item, mode);
    if (result.ok) print('In sync.');
    else {
      print(`Conflicts in:\n${result.conflicts.join('\n')}\nResolve them, then run: wg sync ${item.meta.id} --continue`);
      process.exitCode = 1;
    }
  });

program
  .command('done')
  .description('Rebase, run gates, merge into the integration branch, close the item and clean up')
  .argument('[id]', 'item id (default: current worktree)', parseId)
  .requiredOption('--outcome <text>', 'what changed, in one or two sentences')
  .option('--report <text>', 'plain-language line for the owner (user-visible changes)')
  .option('--no-report', 'nothing user-visible to report')
  .option('--attest <name=value>', 'answer to a configured attestation (ok, n/a or unchanged)', collectAttest, {})
  .option('--attest-reason <name=text>', 'why the required files already cover the change (required with unchanged)', collectAttestReason, {})
  .action(async (id: number | undefined, opts: { outcome: string; report?: string | false; attest: Record<string, string>; attestReason: Record<string, string> }) => {
    const repo = await repoForCwd();
    const itemId = await resolveItemId(repo, id);
    const report = typeof opts.report === 'string' ? opts.report : undefined;
    const result = await doneItem(repo, itemId, {
      outcome: opts.outcome,
      report,
      noReport: opts.report === false,
      attest: opts.attest,
      attestReason: opts.attestReason,
    });
    for (const line of result.log) print(line);
    print(`Done #${itemId}.`);
  });

program
  .command('doctor')
  .description('Validate item files, worktrees and branches')
  .option('--fix', 'regenerate the index')
  .action(async (opts: { fix?: boolean }) => {
    const repo = await repoForCwd();
    const { items, errors } = loadAll(repo);
    const report = await doctor(repo, errors, items);
    if (opts.fix === true && errors.length === 0) {
      print(`Regenerated ${writeIndex(repo, items)}.`);
    }
    if (report.problems.length === 0) print('No problems found.');
    else {
      for (const p of report.problems) print(`problem: ${p}`);
      process.exitCode = 1;
    }
  });

program
  .command('bypass')
  .description('Owner only: skip the item flow for a limited time (run with the ! prefix)')
  .argument('[arg]', 'duration like 30m or 2h, "off" or "status"', 'status')
  .action(async (arg: string) => {
    const repo = await repoForCwd();
    if (arg === 'status') {
      const b = readBypass(repo);
      print(b === undefined ? 'No bypass active.' : `Bypass active (${b.mode}${b.until === undefined ? '' : ` until ${b.until}`}).`);
      return;
    }
    if (arg === 'off') {
      print((await endBypass(repo)) ?? 'Bypass ended.');
      return;
    }
    const ms = parseDuration(arg);
    await startBypass(repo, { kind: 'timed', ms });
    print(`Bypass active for ${arg}. End it early with: wg bypass off`);
  });

const statusline = program.command('statusline').description('Print the status line for Claude Code (reads JSON on stdin)');
statusline.action(async () => {
  process.stdout.write(`${await renderStatusline(await readStdin())}\n`);
});
statusline
  .command('install')
  .description('Install the status line into ~/.claude/settings.json')
  .option('--force', 'replace a different existing statusLine')
  .option('--refresh <seconds>', 'refresh interval', (v) => Number(v), 30)
  .option('--settings <file>', 'settings file to modify (default: ~/.claude/settings.json)')
  .action((opts: { force?: boolean; refresh: number; settings?: string }) => {
    const script = process.argv[1];
    if (script === undefined) throw new WgError('Cannot locate the wg executable.');
    for (const line of installStatusline(realpathSync(script), { force: opts.force === true, refreshSeconds: opts.refresh, settingsFile: opts.settings })) {
      print(line);
    }
  });

program
  .command('hook', { hidden: true })
  .argument('<name>')
  .action(async (name: string) => {
    const valid: HookName[] = ['session-start', 'user-prompt-submit', 'pre-tool-use', 'post-tool-use', 'session-end'];
    if (!valid.includes(name as HookName)) throw new WgError(`Unknown hook "${name}".`);
    try {
      const out = await runHook(name as HookName, await readStdin());
      if (out.stdout !== undefined) process.stdout.write(`${out.stdout}\n`);
      if (out.stderr !== undefined) process.stderr.write(`${out.stderr}\n`);
    } catch (error) {
      // A hook failure must never block the session; report and continue.
      process.stderr.write(`workgate hook ${name} failed: ${(error as Error).message}\n`);
    }
  });

program.parseAsync().catch((error: unknown) => {
  if (error instanceof WgError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
