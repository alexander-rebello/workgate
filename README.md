# workgate

File-backed work items that gate AI-assisted changes behind claimed items, per-item worktrees and a verified merge flow.

- One markdown file per item (`docs/todos/0042-slug.md`), five statuses, no checkboxes, no hand-edited index.
- `wg claim` creates a branch and worktree; `wg done` rebases, runs your gates, checks attestations, merges, closes the item and cleans up. All commits go through the tool.
- A Claude Code plugin enforces the flow with hooks and injects the rules into every session.

## Install

CLI (npm):

```sh
npm install --global workgate
```

Claude Code plugin (bundles the CLI on the PATH, hooks and the `/wg` skill):

```
/plugin marketplace add alexander-rebello/workgate
/plugin install workgate@workgate
```

Per repository:

```sh
wg init --branch main --claude-md
```

This writes `.workgate/config.json` (integration branch, detected `lint`/`build`/`test` gates), creates the items directory and a generated index, and commits them.

## Model

| Status | Meaning | Required fields |
| --- | --- | --- |
| `todo` | ready to pick up | - |
| `active` | being worked on in a worktree | `wt`, `branch` |
| `blocked` | cannot proceed without the owner | `needs` |
| `done` | merged | `outcome`, `closed` |
| `dropped` | superseded or abandoned | `reason`, `closed` |

Kinds: `bug`, `feature`, `rework`, `decision`. Bugs may carry `sev: S1..S4`. Items may declare `after: [ids]` and `parent: id`. Fields are validated on every read; `wg doctor` reports problems.

`blocked` is how the owner is asked for something. Decision items start blocked and are answered with `wg done <id> --outcome "..." (--report "..." | --no-report)`; they are never claimed.

## Commands

| Command | Purpose |
| --- | --- |
| `wg add <title> --kind k [--sev S] [--after ids] [--parent id] [--needs text] [--ref name=value]` | create an item (body from `--body` or stdin); `--ref` links an external tracker and is repeatable |
| `wg list`, `wg find <text>`, `wg show <id>`, `wg next`, `wg stats` | views; most take `--json` |
| `wg claim <id>` | status `active`, create branch and worktree, print the path |
| `wg resume <id>`, `wg release <id>` | re-attach after an interruption, or give an item back |
| `wg body [id] [--set]` | print or replace (stdin) a body: the current worktree's item, or by id an item that was never claimed |
| `wg plan`, `wg plan check\|uncheck <n...>` | list or tick the plan checklist of the current worktree's item |
| `wg checkpoint [message]` | commit pending changes in the current item worktree |
| `wg sync [id] [--continue\|--abort]` | rebase onto the integration branch, resolve conflicts |
| `wg done [id] --outcome t (--report t \| --no-report) [--attest name=ok\|n/a\|unchanged [--attest-reason name=t]]` | rebase, gates, attestations, merge, close, clean up |
| `wg block <id> --needs t`, `wg unblock <id> [answer]` | ask the owner / record the answer |
| `wg drop <id> --reason t [--force]` | close without doing it |
| `wg review [--since d]`, `wg verify <id>`, `wg report [--since d]` | final review queue and meeting report |
| `wg doctor [--fix]` | validate items, worktrees, branches |
| `wg bypass [30m\|off\|status]` | owner only: skip the flow for a limited time |
| `wg statusline`, `wg statusline install` | status line renderer and installer |

`wg stats` prints `blocked/open/total`: items waiting on the owner, open work that is not blocked, and every item ever created.

## Config

`.workgate/config.json`:

```json
{
  "version": 1,
  "integrationBranch": "main",
  "todosDir": "docs/todos",
  "indexFile": "docs/TODO.md",
  "reportFile": null,
  "worktreeDir": "../my-repo-worktrees",
  "leaseMinutes": 30,
  "commitSuffix": "",
  "gates": [{ "name": "lint", "command": "pnpm run lint" }],
  "gateConcurrency": 1,
  "gateWaitMinutes": 8,
  "attestations": [
    {
      "name": "docs",
      "description": "docs/rules and docs/architecture are accurate",
      "watch": ["src/**"],
      "require": ["docs/rules/**", "docs/architecture/**"]
    }
  ],
  "hooks": [{ "on": ["add", "claim", "done"], "command": "./scripts/sync-tracker.sh", "timeoutSeconds": 30 }]
}
```

- `gates` run in the item worktree before a merge; any failure aborts and merges nothing. Agents are told not to run them themselves.
- `gateConcurrency` limits how many `wg done` calls run their gates at the same time, across all sessions on the machine (default 1). The others wait in line, printing who holds the slots, for up to `gateWaitMinutes` (default 8). After that they give up without merging. A slot whose process died is reclaimed, and interrupting `wg done` stops its gate commands. Gates run without the repository lock, so other `wg` commands keep working during a long build. If the integration branch moved in the meantime, `wg done` rebases and runs the gates again before merging.
- `attestations` become mandatory `--attest name=ok|n/a|unchanged` answers on `wg done`. `n/a` is refused when a `watch` file changed and no `require` file did; `ok` is refused when no `require` file changed. `unchanged` means the `require` files were reviewed and already cover the change; it needs `--attest-reason name="<why>"`, which is recorded in the item (`attestReason`) and the merge commit body.
- `commitSuffix` is appended to bookkeeping commit subjects (for example ` [skip ci]`). The merge commit written by `wg done` never gets it, since it carries the real change and is what a push ships.
- `hooks` run after a successful `add`, `claim`, `block`, `done` or `drop` (not `resume`, `release` or `unblock`), through the shell in the main checkout, with `{ "event": "<event>", "item": { ...frontmatter, "file": "<absolute path>" } }` on stdin. The item is read after the operation, so `status` is the new one. Their stdout is printed after the command's output (to stderr with `--json`). A non-zero exit or a timeout (`timeoutSeconds`, default 30; the hook's whole process group is killed) is printed as a warning and never changes the exit code.
- Item `refs` (`wg add --ref taiga=ERP-12`) are stored in the frontmatter as a `name: value` map and included in `--json` output and hook payloads. Names match `^[a-z][a-z0-9-]*$`; values are non-empty.
- `reportFile`, when set, receives a `- date - text (#id)` line for every `--report`.

## What the plugin enforces

- Session start: the workflow rules plus a digest of blocked and stale items are injected into the context.
- Mutating git (`commit`, `merge`, `rebase`, `push`, `branch`, `worktree`, `reset`, `stash`, `checkout`, ...) is denied in Bash; read-only git is allowed.
- Edits (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) are denied unless the file lies in the worktree of an active item. Read-only work needs no item.
- Shell writes into a workgate repository outside an active item's worktree (redirects, `tee`, `sed -i`, `cp`/`mv`/`rm`, `touch`, `mkdir`, `dd of=`) are allowed but get a warning injected into the context. They are not denied because shell parsing is too imprecise for a hard gate; interpreter scripts (`python -c`, `node -e`) are not inspected. Shell writes to item files and the index are denied.
- A heartbeat keeps the lease of the item you work on fresh. An `active` item without a recent heartbeat is shown as stale; nothing is released automatically. `wg resume` re-attaches.
- Starting a prompt with `[quick]` lifts the gate for that prompt only. Commits made during it are recorded as a closed item afterwards. `wg bypass 30m` does the same for a time window and can only be run by the owner (`!` prefix); the agent is denied access to it.

The Bash checks are a guard against mistakes, not a security boundary.

## Working through a backlog

`/wg-run` (plugin) works the ready items unattended. The session you start it in is only a dispatcher. Each item goes to a fresh `wg-worker` subagent with its own context. The subagent claims the item, implements it in its worktree, runs the gates and finishes with `wg done`. If it needs something from the owner, it blocks the item with `wg block --needs` instead. It replies with a single line, so the dispatcher's context grows by about a line per item, and a large backlog fits in one session.

```
/wg-run              # everything that is ready, one at a time
/wg-run 10           # stop after 10 items
/wg-run --parallel 2 # two workers at a time (only for items in separate areas)
```

- Before starting, clean up the backlog: drop duplicates, turn questions into decision items, and set `after:` where order matters. `wg next` decides what runs.
- When the worktree directory is outside the project, add it with `/add-dir` so workers aren't stopped by permission prompts.
- The run stops when nothing is ready, at the limit, or after three items in a row that didn't finish. Then it lists what is waiting on you. Answer with `wg unblock`, check the finished work with `wg review`, and start `/wg-run` again. All state lives in the items, so a run can be resumed from any session.

## Status line

`wg statusline install` copies the renderer to `~/.claude/workgate/wg` and sets `statusLine` (with a 30 second refresh) in `~/.claude/settings.json`. It shows 5-hour and 7-day usage with the reset countdown, context left, the todo counts (`blocked` red, `open` yellow, `total` cyan), the current item and the model. A different existing `statusLine` is only replaced with `--force` and is backed up first.

## Development

```sh
pnpm install
pnpm run verify   # typecheck, lint, build, tests
```

`bin/wg` is a bundled build artifact and is committed because the plugin runs from the git checkout; CI fails when it is stale.
