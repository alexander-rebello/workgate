import { execFile } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import picomatch from 'picomatch';
import { nextItems, planProgress } from './derive.js';
import { WgError } from './errors.js';

import { run, runShell } from './exec.js';
import {
  branchExists,
  changedFiles,
  commitOnly,
  currentBranch,
  git,
  gitOk,
  isCleanTracked,
  listWorktrees,
  type WorktreeInfo,
} from './git.js';
import { writeIndex } from './indexgen.js';
import {
  createItem,
  findItem,
  loadItems,
  nextId,
  parseItem,
  slugify,
  todayIso,
  withoutKeys,
  writeItem,
} from './items.js';
import { worktreeRoot } from './repo.js';
import { clearLease, touchLease, withLock } from './state.js';
import type { Item, ItemMeta, Kind, Repo, Severity } from './types.js';

const KIND_TEMPLATES: Record<Kind, string> = {
  bug: '## Repro\n\n## Expected\n\n## Actual\n\n## Plan\n\n- [ ] ',
  feature: '## Goal\n\n## Plan\n\n- [ ] ',
  rework: '## Why\n\n## Plan\n\n- [ ] ',
  decision: '## Question\n\n## Options\n\n## Recommendation\n',
};

function subject(repo: Repo, text: string): string {
  return `${text}${repo.config.commitSuffix}`;
}

async function requireIntegration(repo: Repo): Promise<void> {
  const branch = await currentBranch(repo.mainRoot);
  if (branch !== repo.config.integrationBranch) {
    throw new WgError(
      `The main checkout (${repo.mainRoot}) is on "${branch}", expected "${repo.config.integrationBranch}".`,
    );
  }
}

/** Writes the index and commits the touched item files plus the index on the integration branch. */
async function commitBookkeeping(
  repo: Repo,
  touched: readonly Item[],
  text: string,
  id: number,
  extraPaths: readonly string[] = [],
): Promise<void> {
  const all = loadItems(repo);
  const indexRel = writeIndex(repo, all);
  const paths = [...touched.map((i) => relative(repo.mainRoot, i.file)), indexRel, ...extraPaths];
  const first = subject(repo, text);
  await commitOnly(repo.mainRoot, paths, `${first}\n\nTodo: #${id}`);
}

export interface AddOptions {
  title: string;
  kind: Kind;
  sev?: Severity | undefined;
  body?: string | undefined;
  after?: number[] | undefined;
  parent?: number | undefined;
  needs?: string | undefined;
}

export async function addItem(repo: Repo, options: AddOptions): Promise<Item> {
  return withLock(repo, async () => {
    await requireIntegration(repo);
    const items = loadItems(repo);
    for (const dep of options.after ?? []) findItem(items, dep);
    if (options.parent !== undefined) findItem(items, options.parent);
    const needs = options.needs;
    if (options.kind === 'decision' && needs === undefined) {
      throw new WgError('Decision items require --needs (what the owner has to answer).');
    }
    if (options.sev !== undefined && options.kind !== 'bug') {
      throw new WgError('--sev is only valid for bugs.');
    }
    const meta: ItemMeta = {
      id: nextId(items),
      title: options.title.trim(),
      kind: options.kind,
      status: needs === undefined ? 'todo' : 'blocked',
      created: todayIso(),
      ...(options.sev === undefined ? {} : { sev: options.sev }),
      ...(needs === undefined ? {} : { needs }),
      ...(options.after === undefined || options.after.length === 0 ? {} : { after: options.after }),
      ...(options.parent === undefined ? {} : { parent: options.parent }),
    };
    const body = options.body !== undefined && options.body.trim() !== '' ? options.body : KIND_TEMPLATES[options.kind];
    const item = createItem(repo, meta, body);
    await commitBookkeeping(repo, [item], `wg: add #${meta.id} ${meta.title}`, meta.id);
    return item;
  });
}

export interface ClaimResult {
  item: Item;
  worktree: string;
  branch: string;
  resumed: boolean;
}

function worktreePathFor(repo: Repo, branch: string): string {
  return join(worktreeRoot(repo), branch);
}

/** Matches by path as well, because a worktree in the middle of a rebase reports a detached HEAD. */
async function worktreeOfBranch(repo: Repo, branch: string): Promise<WorktreeInfo | undefined> {
  const list = await listWorktrees(repo.mainRoot);
  const expected = worktreePathFor(repo, branch);
  return list.find((w) => w.branch === branch || w.path === expected);
}

export async function claimItem(repo: Repo, id: number): Promise<ClaimResult> {
  return withLock(repo, async () => {
    await requireIntegration(repo);
    const items = loadItems(repo);
    const item = findItem(items, id);
    if (item.meta.status === 'active') {
      throw new WgError(`#${id} is already active. Use "wg resume ${id}".`);
    }
    if (item.meta.status !== 'todo') {
      throw new WgError(`#${id} is ${item.meta.status}; only todo items can be claimed.`);
    }
    const pending = (item.meta.after ?? []).filter((dep) => {
      const d = items.find((i) => i.meta.id === dep);
      return d === undefined || (d.meta.status !== 'done' && d.meta.status !== 'dropped');
    });
    if (pending.length > 0) {
      throw new WgError(`#${id} waits on ${pending.map((p) => `#${p}`).join(', ')}.`);
    }
    if (item.meta.kind === 'decision') {
      throw new WgError('Decision items are answered, not claimed. Use "wg done" with an outcome.');
    }

    const branch = `${id}-${slugify(item.meta.title)}`;
    const path = worktreePathFor(repo, branch);
    const next = writeItem(item, {
      ...item.meta,
      status: 'active',
      started: todayIso(),
      wt: branch,
      branch,
    });
    await commitBookkeeping(repo, [next], `wg: claim #${id} ${item.meta.title}`, id);

    try {
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        if (await branchExists(repo.mainRoot, branch)) {
          await git(repo.mainRoot, ['worktree', 'add', path, branch]);
        } else {
          await git(repo.mainRoot, ['worktree', 'add', '-b', branch, path, repo.config.integrationBranch]);
        }
      }
    } catch (error) {
      const reverted = writeItem(next, withoutKeys({ ...next.meta, status: 'todo' }, ['started', 'wt', 'branch']));
      await commitBookkeeping(repo, [reverted], `wg: unclaim #${id} (worktree failed)`, id);
      throw error;
    }
    touchLease(repo, id);
    return { item: next, worktree: path, branch, resumed: false };
  });
}

export async function resumeItem(repo: Repo, id: number): Promise<ClaimResult & { progress: { done: number; total: number } }> {
  return withLock(repo, async () => {
    const item = findItem(loadItems(repo), id);
    if (item.meta.status !== 'active' || item.meta.branch === undefined) {
      throw new WgError(`#${id} is ${item.meta.status}, not active.`);
    }
    const info = await worktreeOfBranch(repo, item.meta.branch);
    if (info === undefined) {
      throw new WgError(`The worktree for #${id} (${item.meta.branch}) no longer exists. Release it with "wg release ${id}".`);
    }
    touchLease(repo, id);
    const worktreeItem = join(info.path, item.file.slice(repo.mainRoot.length + 1));
    const body = existsSync(worktreeItem) ? parseItem(readFileSync(worktreeItem, 'utf8'), worktreeItem).body : item.body;
    return { item, worktree: info.path, branch: item.meta.branch, resumed: true, progress: planProgress(body) };
  });
}

export async function releaseItem(repo: Repo, id: number): Promise<Item> {
  return withLock(repo, async () => {
    await requireIntegration(repo);
    const item = findItem(loadItems(repo), id);
    if (item.meta.status !== 'active') throw new WgError(`#${id} is ${item.meta.status}, not active.`);
    const next = writeItem(item, withoutKeys({ ...item.meta, status: 'todo' }, ['started', 'wt', 'branch']));
    await commitBookkeeping(repo, [next], `wg: release #${id} ${item.meta.title}`, id);
    clearLease(repo, id);
    return next;
  });
}

export async function blockItem(repo: Repo, id: number, needs: string): Promise<Item> {
  return withLock(repo, async () => {
    await requireIntegration(repo);
    const item = findItem(loadItems(repo), id);
    if (item.meta.status === 'done' || item.meta.status === 'dropped') {
      throw new WgError(`#${id} is already ${item.meta.status}.`);
    }
    const next = writeItem(item, { ...item.meta, status: 'blocked', needs: needs.trim() });
    await commitBookkeeping(repo, [next], `wg: block #${id} ${item.meta.title}`, id);
    return next;
  });
}

export async function unblockItem(repo: Repo, id: number, answer: string | undefined): Promise<Item> {
  return withLock(repo, async () => {
    await requireIntegration(repo);
    const item = findItem(loadItems(repo), id);
    if (item.meta.status !== 'blocked') throw new WgError(`#${id} is ${item.meta.status}, not blocked.`);
    const status = item.meta.branch === undefined ? 'todo' : 'active';
    const base = withoutKeys({ ...item.meta, status }, ['needs']);
    const body = answer === undefined || answer.trim() === ''
      ? item.body
      : `${item.body}\n\n## Answer (${todayIso()})\n\n${answer.trim()}`;
    const next = writeItem(item, base, body);
    await commitBookkeeping(repo, [next], `wg: unblock #${id} ${item.meta.title}`, id);
    if (status === 'active') touchLease(repo, id);
    return next;
  });
}

export async function dropItem(repo: Repo, id: number, reason: string, force: boolean): Promise<Item> {
  return withLock(repo, async () => {
    await requireIntegration(repo);
    const item = findItem(loadItems(repo), id);
    if (item.meta.status === 'done' || item.meta.status === 'dropped') {
      throw new WgError(`#${id} is already ${item.meta.status}.`);
    }
    if (item.meta.branch !== undefined) {
      const ahead = await git(repo.mainRoot, ['rev-list', '--count', `${repo.config.integrationBranch}..${item.meta.branch}`]).catch(() => '0');
      if (Number(ahead) > 0 && !force) {
        throw new WgError(`#${id} has ${ahead} unmerged commit(s) on ${item.meta.branch}. Use --force to discard them.`);
      }
      const info = await worktreeOfBranch(repo, item.meta.branch);
      if (info !== undefined) await git(repo.mainRoot, ['worktree', 'remove', '--force', info.path]);
      if (await branchExists(repo.mainRoot, item.meta.branch)) {
        await git(repo.mainRoot, ['branch', '-D', item.meta.branch]);
      }
    }
    const next = writeItem(
      item,
      withoutKeys({ ...item.meta, status: 'dropped', closed: todayIso(), reason: reason.trim() }, ['wt', 'branch', 'needs']),
    );
    await commitBookkeeping(repo, [next], `wg: drop #${id} ${item.meta.title}`, id);
    clearLease(repo, id);
    return next;
  });
}

export async function verifyItem(repo: Repo, id: number): Promise<Item> {
  return withLock(repo, async () => {
    await requireIntegration(repo);
    const item = findItem(loadItems(repo), id);
    if (item.meta.status !== 'done') throw new WgError(`#${id} is ${item.meta.status}; only done items can be verified.`);
    const next = writeItem(item, { ...item.meta, verified: true });
    await commitBookkeeping(repo, [next], `wg: verify #${id} ${item.meta.title}`, id);
    return next;
  });
}

export function findItemByWorktree(repo: Repo, items: readonly Item[], toplevel: string): Item | undefined {
  return items.find(
    (i) => i.meta.status === 'active' && i.meta.branch !== undefined && worktreePathFor(repo, i.meta.branch) === toplevel,
  );
}

export async function itemForToplevel(repo: Repo, toplevel: string): Promise<Item | undefined> {
  const items = loadItems(repo);
  const direct = findItemByWorktree(repo, items, toplevel);
  if (direct !== undefined) return direct;
  const list = await listWorktrees(repo.mainRoot);
  const info = list.find((w) => w.path === toplevel);
  if (info?.branch === undefined) return undefined;
  return items.find((i) => i.meta.status === 'active' && i.meta.branch === info.branch);
}

async function worktreeItem(repo: Repo, cwd: string): Promise<Item> {
  const item = await requireItemForCwd(repo, cwd);
  const info = await worktreeOfBranch(repo, item.meta.branch ?? '');
  if (info === undefined) throw new WgError(`Worktree for #${item.meta.id} not found.`);
  const file = join(info.path, repo.config.todosDir, basename(item.file));
  if (!existsSync(file)) throw new WgError(`${file} not found in the worktree.`);
  return parseItem(readFileSync(file, 'utf8'), file);
}

export interface PlanStep {
  n: number;
  checked: boolean;
  text: string;
}

const STEP = /^(\s*- \[)([ xX])(\] ?)(.*)$/;

export function planSteps(body: string): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const line of body.split('\n')) {
    const m = STEP.exec(line);
    if (m !== null) steps.push({ n: steps.length + 1, checked: m[2] !== ' ', text: m[4] ?? '' });
  }
  return steps;
}

/** The body is read from and written to the item's worktree copy; the frontmatter is never touched. */
export async function readBody(repo: Repo, cwd: string): Promise<string> {
  return (await worktreeItem(repo, cwd)).body;
}

export async function setBody(repo: Repo, cwd: string, body: string): Promise<void> {
  const item = await worktreeItem(repo, cwd);
  writeItem(item, item.meta, body);
  touchLease(repo, item.meta.id);
}

export async function markSteps(
  repo: Repo,
  cwd: string,
  numbers: readonly number[],
  checked: boolean,
): Promise<{ done: number; total: number }> {
  const item = await worktreeItem(repo, cwd);
  const total = planSteps(item.body).length;
  for (const n of numbers) {
    if (!Number.isInteger(n) || n < 1 || n > total) throw new WgError(`#${item.meta.id} has no plan step ${n} (${total} step(s)).`);
  }
  const wanted = new Set(numbers);
  let seen = 0;
  const lines = item.body.split('\n').map((line) => {
    const m = STEP.exec(line);
    if (m === null) return line;
    seen += 1;
    return wanted.has(seen) ? `${m[1] ?? ''}${checked ? 'x' : ' '}${m[3] ?? ''}${m[4] ?? ''}` : line;
  });
  const body = lines.join('\n');
  writeItem(item, item.meta, body);
  touchLease(repo, item.meta.id);
  return planProgress(body);
}

export async function checkpoint(repo: Repo, cwd: string, message: string | undefined): Promise<string> {
  const item = await requireItemForCwd(repo, cwd);
  const info = await worktreeOfBranch(repo, item.meta.branch ?? '');
  if (info === undefined) throw new WgError(`Worktree for #${item.meta.id} not found.`);
  await git(info.path, ['add', '-A']);
  const staged = await git(info.path, ['diff', '--cached', '--name-only']);
  if (staged === '') return 'Nothing to commit.';
  const subjectLine = `${item.meta.title} (#${item.meta.id})${message === undefined || message === '' ? '' : `: ${message}`}`;
  await git(info.path, ['commit', '-m', `${subjectLine}\n\nTodo: #${item.meta.id}`]);
  touchLease(repo, item.meta.id);
  return `Committed ${staged.split('\n').length} file(s) to ${item.meta.branch}.`;
}

export async function requireItemForCwd(repo: Repo, cwd: string): Promise<Item> {
  const item = await itemForToplevel(repo, repo.toplevel);
  if (item === undefined) {
    throw new WgError(`${cwd} is not inside an active item's worktree. Pass an id or run "wg claim <id>".`);
  }
  return item;
}

export interface SyncResult {
  ok: boolean;
  conflicts: string[];
}

export async function syncItem(repo: Repo, item: Item, mode: 'start' | 'continue' | 'abort'): Promise<SyncResult> {
  const branch = item.meta.branch;
  if (branch === undefined) throw new WgError(`#${item.meta.id} has no branch.`);
  const info = await worktreeOfBranch(repo, branch);
  if (info === undefined) throw new WgError(`Worktree for #${item.meta.id} not found.`);
  const env = { ...process.env, GIT_EDITOR: 'true' };
  const runRebase = async (args: string[]): Promise<{ code: number; stderr: string }> => {
    return new Promise((resolve) => {
      execFile('git', args, { cwd: info.path, env, encoding: 'utf8' }, (error, _out, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stderr });
      });
    });
  };
  if (mode === 'abort') {
    await runRebase(['rebase', '--abort']);
    return { ok: true, conflicts: [] };
  }
  if (mode === 'start') {
    await git(info.path, ['add', '-A']);
    const staged = await git(info.path, ['diff', '--cached', '--name-only']);
    if (staged !== '') await git(info.path, ['commit', '-m', `${item.meta.title} (#${item.meta.id})\n\nTodo: #${item.meta.id}`]);
  } else {
    await git(info.path, ['add', '-A']);
  }
  const result = await runRebase(mode === 'continue' ? ['rebase', '--continue'] : ['rebase', repo.config.integrationBranch]);
  if (result.code === 0) return { ok: true, conflicts: [] };
  const conflicts = (await git(info.path, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter((l) => l !== '');
  if (conflicts.length === 0) {
    await runRebase(['rebase', '--abort']);
    throw new WgError(`Rebase failed: ${result.stderr.trim()}`);
  }
  return { ok: false, conflicts };
}

function trimmedReasons(raw: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw)
      .map(([name, text]): [string, string] => [name, text.trim()])
      .filter(([, text]) => text !== ''),
  );
}

export function checkAttestations(
  repo: Repo,
  provided: Record<string, string>,
  files: readonly string[],
  reasons: Record<string, string> = {},
): string[] {
  const problems: string[] = [];
  for (const att of repo.config.attestations) {
    const value = provided[att.name];
    if (value === undefined) {
      problems.push(`Missing --attest ${att.name}=ok|n/a|unchanged (${att.description}).`);
      continue;
    }
    if (value !== 'ok' && value !== 'n/a' && value !== 'unchanged') {
      problems.push(`--attest ${att.name} must be "ok", "n/a" or "unchanged", got "${value}".`);
      continue;
    }
    const reason = reasons[att.name]?.trim() ?? '';
    // "unchanged" is the only answer the diff cannot check, so it must carry a recorded justification.
    if (value === 'unchanged') {
      if (reason === '') {
        problems.push(`--attest ${att.name}=unchanged needs --attest-reason ${att.name}="<why ${att.require.join(', ') || 'the required files'} already cover this change>".`);
      }
      continue;
    }
    if (reason !== '') {
      problems.push(`--attest-reason ${att.name} is only valid with --attest ${att.name}=unchanged.`);
    }
    const watched = att.watch.length > 0 ? files.filter((f) => picomatch.isMatch(f, att.watch)) : [];
    const satisfied = att.require.length > 0 && files.some((f) => picomatch.isMatch(f, att.require));
    if (value === 'n/a' && watched.length > 0 && !satisfied) {
      problems.push(
        `--attest ${att.name}=n/a is inconsistent: ${watched.slice(0, 3).join(', ')} changed but nothing matching ${att.require.join(', ')} did.`,
      );
    }
    if (value === 'ok' && att.require.length > 0 && !satisfied) {
      problems.push(`--attest ${att.name}=ok but no file matching ${att.require.join(', ')} changed.`);
    }
  }
  return problems;
}

export interface DoneOptions {
  outcome: string;
  report?: string | undefined;
  noReport: boolean;
  attest: Record<string, string>;
  attestReason?: Record<string, string> | undefined;
}

export interface DoneResult {
  item: Item;
  log: string[];
}

function appendReportLine(repo: Repo, report: string | undefined, id: number): string[] {
  if (repo.config.reportFile === null || report === undefined) return [];
  const reportPath = join(repo.mainRoot, repo.config.reportFile);
  mkdirSync(dirname(reportPath), { recursive: true });
  const existing = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n';
  appendFileSync(reportPath, `${prefix}- ${todayIso()} — ${report.trim()} (#${id})\n`);
  return [repo.config.reportFile];
}

async function runGates(repo: Repo, cwd: string, log: string[]): Promise<void> {
  for (const gate of repo.config.gates) {
    log.push(`gate ${gate.name}: ${gate.command}`);
    const result = await runShell(gate.command, cwd);
    if (result.code !== 0) {
      const tail = result.output.trimEnd().split('\n').slice(-40).join('\n');
      throw new WgError(`Gate "${gate.name}" failed (exit ${result.code}). Nothing was merged.\n${tail}`);
    }
  }
}

export async function doneItem(repo: Repo, id: number, options: DoneOptions): Promise<DoneResult> {
  return withLock(repo, async () => {
    await requireIntegration(repo);
    const log: string[] = [];
    const items = loadItems(repo);
    const item = findItem(items, id);

    if (options.report === undefined && !options.noReport) {
      throw new WgError('Pass --report "<plain sentence>" for user-visible changes, or --no-report.');
    }
    if (options.report !== undefined && options.noReport) throw new WgError('Use either --report or --no-report.');

    if (item.meta.status !== 'active') {
      if (item.meta.kind === 'decision' && (item.meta.status === 'blocked' || item.meta.status === 'todo')) {
        const next = writeItem(
          item,
          withoutKeys(
            {
              ...item.meta,
              status: 'done',
              closed: todayIso(),
              outcome: options.outcome.trim(),
              ...(options.report === undefined ? {} : { report: options.report.trim() }),
            },
            ['needs'],
          ),
        );
        const extra = appendReportLine(repo, options.report, id);
        await commitBookkeeping(repo, [next], `wg: decide #${id} ${item.meta.title}`, id, extra);
        log.push(`Decision #${id} recorded.`);
        return { item: next, log };
      }
      throw new WgError(`#${id} is ${item.meta.status}. Claim it first with "wg claim ${id}".`);
    }
    const branch = item.meta.branch;
    if (branch === undefined) throw new WgError(`#${id} has no branch.`);
    if (!(await isCleanTracked(repo.mainRoot))) {
      throw new WgError('The main checkout has uncommitted changes. Commit or stash them, then retry.');
    }
    const info = await worktreeOfBranch(repo, branch);
    if (info === undefined) throw new WgError(`Worktree for #${id} not found.`);

    const sync = await syncItem(repo, item, 'start');
    if (!sync.ok) {
      throw new WgError(
        `Rebase onto ${repo.config.integrationBranch} has conflicts in:\n${sync.conflicts.join('\n')}\nResolve the files, then run "wg sync ${id} --continue" (or "wg sync ${id} --abort"), then "wg done" again.`,
      );
    }
    log.push(`rebased ${branch} onto ${repo.config.integrationBranch}`);

    await runGates(repo, info.path, log);

    const files = await changedFiles(info.path, repo.config.integrationBranch, branch);
    if (files.length === 0) throw new WgError(`${branch} has no changes relative to ${repo.config.integrationBranch}.`);
    const reasons = trimmedReasons(options.attestReason ?? {});
    const problems = checkAttestations(repo, options.attest, files, reasons);
    if (problems.length > 0) throw new WgError(problems.join('\n'));
    const unchanged = Object.entries(options.attest).filter(([, value]) => value === 'unchanged');

    const overlaps = await overlapWarnings(repo, items, item, files);
    log.push(...overlaps);

    const mergeMsg = `Merge ${branch}: ${item.meta.title} (#${id})${repo.config.commitSuffix}`;
    const merge = await gitOkOutput(repo.mainRoot, ['merge', '--no-ff', '--no-commit', branch]);
    if (!merge.ok) {
      await gitOk(repo.mainRoot, ['merge', '--abort']);
      throw new WgError(`Merge into ${repo.config.integrationBranch} failed and was aborted:\n${merge.output}`);
    }
    try {
      const merged = findItem(loadItems(repo), id);
      const closedMeta = withoutKeys(
        {
          ...merged.meta,
          status: 'done',
          closed: todayIso(),
          outcome: options.outcome.trim(),
          ...(options.report === undefined ? {} : { report: options.report.trim() }),
          ...(Object.keys(options.attest).length === 0 ? {} : { attest: options.attest }),
          ...(Object.keys(reasons).length === 0 ? {} : { attestReason: reasons }),
        },
        ['wt', 'branch', 'needs'],
      );
      const next = writeItem(merged, closedMeta);
      const all = loadItems(repo);
      const indexRel = writeIndex(repo, all);
      const paths = [relative(repo.mainRoot, next.file), indexRel];
      paths.push(...appendReportLine(repo, options.report, id));
      await git(repo.mainRoot, ['add', '--all', '--', ...paths]);
      const attestLines = unchanged.map(([name]) => `Attest ${name}: unchanged - ${reasons[name] ?? ''}`);
      const body = [...attestLines, `Todo: #${id}`].join('\n');
      await git(repo.mainRoot, ['commit', '--no-verify', '-m', `${mergeMsg}\n\n${body}`]);
      log.push(`merged ${branch} into ${repo.config.integrationBranch}`);
      await git(repo.mainRoot, ['worktree', 'remove', '--force', info.path]);
      await git(repo.mainRoot, ['branch', '-d', branch]);
      clearLease(repo, id);
      log.push('removed worktree and branch');
      log.push(`The worktree is gone; continue from ${repo.mainRoot}.`);
      return { item: next, log };
    } catch (error) {
      await gitOk(repo.mainRoot, ['merge', '--abort']);
      throw error;
    }
  });
}

async function gitOkOutput(cwd: string, args: readonly string[]): Promise<{ ok: boolean; output: string }> {
  const result = await run('git', args, cwd);
  return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

export async function overlapWarnings(
  repo: Repo,
  items: readonly Item[],
  self: Item,
  files: readonly string[],
): Promise<string[]> {
  const warnings: string[] = [];
  for (const other of items) {
    if (other.meta.id === self.meta.id || other.meta.status !== 'active' || other.meta.branch === undefined) continue;
    const theirs = await changedFiles(repo.mainRoot, repo.config.integrationBranch, other.meta.branch).catch(() => []);
    const shared = theirs.filter((f) => files.includes(f));
    if (shared.length > 0) {
      warnings.push(`warning: #${other.meta.id} also changes ${shared.slice(0, 5).join(', ')}${shared.length > 5 ? ', ...' : ''}`);
    }
  }
  return warnings;
}

export interface DoctorReport {
  problems: string[];
  fixed: string[];
}

export async function doctor(repo: Repo, loadErrors: readonly string[], items: readonly Item[]): Promise<DoctorReport> {
  const problems = [...loadErrors];
  const worktrees = await listWorktrees(repo.mainRoot);
  for (const item of items) {
    if (item.meta.status !== 'active' || item.meta.branch === undefined) continue;
    if (!worktrees.some((w) => w.branch === item.meta.branch)) {
      problems.push(`#${item.meta.id} is active but worktree/branch ${item.meta.branch} does not exist.`);
    }
  }
  const root = worktreeRoot(repo);
  for (const w of worktrees) {
    if (!w.path.startsWith(`${root}/`)) continue;
    const owner = items.find((i) => i.meta.status === 'active' && i.meta.branch === w.branch);
    if (owner === undefined) problems.push(`Orphan worktree ${w.path} (branch ${w.branch ?? 'detached'}) has no active item.`);
  }
  const branches = (await git(repo.mainRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).split('\n');
  for (const b of branches) {
    const m = /^(\d+)-/.exec(b);
    if (m === null) continue;
    const idNum = Number(m[1]);
    const owner = items.find((i) => i.meta.id === idNum);
    if (owner === undefined) problems.push(`Branch ${b} has no item #${idNum}.`);
    else if (owner.meta.status === 'done') problems.push(`Branch ${b} still exists but #${idNum} is done.`);
  }
  for (const item of items) {
    for (const dep of item.meta.after ?? []) {
      if (!items.some((i) => i.meta.id === dep)) problems.push(`#${item.meta.id} depends on missing #${dep}.`);
    }
    if (item.meta.parent !== undefined && !items.some((i) => i.meta.id === item.meta.parent)) {
      problems.push(`#${item.meta.id} has missing parent #${item.meta.parent}.`);
    }
  }
  return { problems, fixed: [] };
}

export { nextItems };

export function writeFileEnsured(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
