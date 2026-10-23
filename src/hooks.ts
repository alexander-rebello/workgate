import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { z } from 'zod';
import { endBypass, startBypass } from './bypass.js';
import { currentItemText, digestText, rulesText } from './context.js';
import { mutatingGit, shellWriteTargets, touchesProtectedState, writesProtectedPaths } from './guard.js';
import { loadAll } from './items.js';
import { itemForToplevel } from './ops.js';
import { tryResolveRepo } from './repo.js';
import { bypassActive, leaseAgeMinutes, readBypass, touchLease } from './state.js';
import type { Repo } from './types.js';

const HookInputSchema = z
  .object({
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    prompt: z.string().optional(),
  })
  .loose();

export type HookInput = z.infer<typeof HookInputSchema>;
export type HookName = 'session-start' | 'user-prompt-submit' | 'pre-tool-use' | 'post-tool-use' | 'session-end';

export interface HookOutput {
  stdout?: string;
  stderr?: string;
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const HEARTBEAT_THROTTLE_MINUTES = 1;

export function parseHookInput(raw: string): HookInput {
  try {
    const parsed = HookInputSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function context(event: string, text: string): HookOutput {
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) };
}

function deny(reason: string): HookOutput {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  };
}

function nearestExistingDir(path: string): string {
  let dir = dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

const ITEM_FILES_HELP =
  'Workgate: item files and the index are read-only for agents. Edit the plan with wg plan check|uncheck <n> or wg body --set (stdin); change status with the wg commands.';

function itemFilePaths(repo: Repo): string[] {
  return [repo.config.todosDir, repo.config.indexFile];
}

function isItemFile(repo: Repo, abs: string): boolean {
  const rel = relative(repo.toplevel, abs);
  if (rel.startsWith('..')) return false;
  return rel === repo.config.indexFile || rel === repo.config.todosDir || rel.startsWith(`${repo.config.todosDir}/`);
}

const NO_ITEM_HELP =
  'Workgate: this change is not covered by an active item. Run: wg add "<title>" --kind <kind>, then wg claim <id>, and edit inside the printed worktree. The owner can skip this with a [quick] prompt.';

async function gateWrite(input: HookInput): Promise<HookOutput | undefined> {
  const ti = input.tool_input ?? {};
  const raw = ti['file_path'] ?? ti['notebook_path'];
  if (typeof raw !== 'string') return undefined;
  const abs = resolve(input.cwd ?? process.cwd(), raw);
  if (/\/\.git\/workgate(\/|$)/.test(abs)) return deny('Workgate state is managed by the owner and the wg tool only.');
  const repo = await tryResolveRepo(nearestExistingDir(abs));
  if (repo === undefined) return undefined;
  if (isItemFile(repo, abs)) return deny(ITEM_FILES_HELP);
  if (bypassActive(repo, input.session_id)) return undefined;
  const item = await itemForToplevel(repo, repo.toplevel);
  if (item !== undefined) return undefined;
  return deny(NO_ITEM_HELP);
}

async function gateBash(input: HookInput): Promise<HookOutput | undefined> {
  const command = input.tool_input?.['command'];
  if (typeof command !== 'string') return undefined;
  const repo = await tryResolveRepo(input.cwd ?? process.cwd());
  if (repo === undefined) return undefined;
  if (touchesProtectedState(command)) {
    return deny('Only the owner may manage workgate bypass or its state; run it yourself with the ! prefix.');
  }
  if (writesProtectedPaths(command, itemFilePaths(repo))) return deny(ITEM_FILES_HELP);
  const mutating = mutatingGit(command);
  if (mutating.length === 0) return warnUnclaimedWrites(input, command);
  if (bypassActive(repo, input.session_id)) {
    const push = mutating.find((m) => m.subcommand === 'push');
    if (push === undefined) return undefined;
    return deny('Pushing needs an explicit instruction from the owner, even during a bypass.');
  }
  const names = [...new Set(mutating.map((m) => `git ${m.subcommand}`.trim()))].join(', ');
  return deny(
    `Workgate: ${names} is not allowed here. Use wg checkpoint / wg done / wg claim instead; read-only git commands are fine.`,
  );
}

/**
 * Shell writes are not denied like Edit/Write: static analysis of shell is too imprecise for a hard
 * gate. A warning still catches the common case of an agent falling back to the shell after a deny.
 */
async function warnUnclaimedWrites(input: HookInput, command: string): Promise<HookOutput | undefined> {
  const cwd = input.cwd ?? process.cwd();
  const uncovered: string[] = [];
  const coveredByDir = new Map<string, boolean>();
  for (const target of shellWriteTargets(command)) {
    const abs = resolve(cwd, target === '~' || target.startsWith('~/') ? homedir() + target.slice(1) : target);
    const dir = nearestExistingDir(abs);
    let covered = coveredByDir.get(dir);
    if (covered === undefined) {
      const repo = await tryResolveRepo(dir);
      covered = repo === undefined || bypassActive(repo, input.session_id) || (await itemForToplevel(repo, repo.toplevel)) !== undefined;
      coveredByDir.set(dir, covered);
    }
    if (!covered) uncovered.push(target);
  }
  if (uncovered.length === 0) return undefined;
  const shown = uncovered.slice(0, 3).join(', ') + (uncovered.length > 3 ? ', ...' : '');
  return context(
    'PreToolUse',
    `Workgate: this command writes ${shown}, which no active item covers. Shell writes are not blocked, but they skip the item flow exactly like a denied Edit would. If this is part of a change, run wg add and wg claim and work inside the printed worktree; keep scratch files outside the repository.`,
  );
}

async function itemFor(repo: Repo): Promise<ReturnType<typeof itemForToplevel>> {
  return itemForToplevel(repo, repo.toplevel);
}

async function sessionStart(input: HookInput): Promise<HookOutput> {
  const repo = await tryResolveRepo(input.cwd ?? process.cwd());
  if (repo === undefined) return {};
  const note = await endExpiredBypass(repo);
  const { items } = loadAll(repo);
  const parts = [rulesText(repo)];
  const digest = digestText(repo, items);
  if (digest !== '') parts.push(digest);
  const current = await itemFor(repo);
  if (current !== undefined) {
    touchLease(repo, current.meta.id);
    parts.push(currentItemText(current));
  }
  if (note !== undefined) parts.push(note);
  return context('SessionStart', parts.join('\n\n'));
}

async function endExpiredBypass(repo: Repo): Promise<string | undefined> {
  const bypass = readBypass(repo);
  if (bypass === undefined) return undefined;
  if (bypass.mode === 'timed' && bypass.until !== undefined && new Date(bypass.until).getTime() > Date.now()) {
    return undefined;
  }
  if (bypass.mode === 'prompt') return undefined;
  return endBypass(repo);
}

async function userPromptSubmit(input: HookInput): Promise<HookOutput> {
  const repo = await tryResolveRepo(input.cwd ?? process.cwd());
  if (repo === undefined) return {};
  const quick = /^\s*\[quick\]/i.test(input.prompt ?? '');
  const session = input.session_id ?? '';
  const notes: string[] = [];

  const existing = readBypass(repo);
  if (existing?.mode === 'prompt' && !quick) {
    const note = await endBypass(repo);
    if (note !== undefined) notes.push(note);
  }
  const expired = await endExpiredBypass(repo);
  if (expired !== undefined) notes.push(expired);

  if (quick) {
    await startBypass(repo, { kind: 'prompt', session });
    notes.push(
      'Workgate bypass is active for this prompt only: no item is needed and mutating git (except push) is allowed. Keep the change small; it is recorded as an item afterwards.',
    );
    return context('UserPromptSubmit', notes.join('\n'));
  }
  if (bypassActive(repo, input.session_id)) return notes.length === 0 ? {} : context('UserPromptSubmit', notes.join('\n'));

  const current = await itemFor(repo);
  if (current === undefined) {
    notes.push(
      'Workgate: no active item in this working directory. If this request changes files, run wg add and wg claim first (see the rules injected at session start). Read-only requests need no item.',
    );
  }
  return notes.length === 0 ? {} : context('UserPromptSubmit', notes.join('\n'));
}

async function preToolUse(input: HookInput): Promise<HookOutput> {
  const tool = input.tool_name ?? '';
  if (WRITE_TOOLS.has(tool)) return (await gateWrite(input)) ?? {};
  if (tool === 'Bash') return (await gateBash(input)) ?? {};
  return {};
}

/**
 * The directory a tool call worked in. A file tool counts for the file it touched, not the session cwd:
 * a subagent dispatched from the main checkout edits its item's worktree by absolute path, and that
 * item's lease must stay fresh.
 */
function workDir(input: HookInput): string {
  const cwd = input.cwd ?? process.cwd();
  if (!WRITE_TOOLS.has(input.tool_name ?? '')) return cwd;
  const ti = input.tool_input ?? {};
  const raw = ti['file_path'] ?? ti['notebook_path'];
  return typeof raw === 'string' ? nearestExistingDir(resolve(cwd, raw)) : cwd;
}

async function postToolUse(input: HookInput): Promise<HookOutput> {
  const repo = await tryResolveRepo(workDir(input));
  if (repo === undefined) return {};
  const current = await itemFor(repo);
  if (current === undefined) return {};
  const age = leaseAgeMinutes(repo, current.meta.id);
  if (age === undefined || age >= HEARTBEAT_THROTTLE_MINUTES) touchLease(repo, current.meta.id);
  return {};
}

async function sessionEnd(input: HookInput): Promise<HookOutput> {
  const repo = await tryResolveRepo(input.cwd ?? process.cwd());
  if (repo === undefined) return {};
  const bypass = readBypass(repo);
  if (bypass?.mode === 'prompt' && bypass.session === input.session_id) {
    const note = await endBypass(repo);
    if (note !== undefined) return { stderr: note };
  }
  return {};
}

export async function runHook(name: HookName, rawInput: string): Promise<HookOutput> {
  const input = parseHookInput(rawInput);
  switch (name) {
    case 'session-start':
      return sessionStart(input);
    case 'user-prompt-submit':
      return userPromptSubmit(input);
    case 'pre-tool-use':
      return preToolUse(input);
    case 'post-tool-use':
      return postToolUse(input);
    case 'session-end':
      return sessionEnd(input);
  }
}
