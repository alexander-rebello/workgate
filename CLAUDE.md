# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
pnpm install
pnpm run verify                       # typecheck + lint + build + test (what CI runs)
pnpm run build                        # esbuild src/cli.ts -> bin/wg
pnpm run typecheck
pnpm run lint                         # eslint src test
pnpm run test                         # vitest run
pnpm exec vitest run test/guard.test.ts            # one file
pnpm exec vitest run -t "name fragment"            # one test by name
```

## Build artifact: bin/wg is committed

`bin/wg` is the esbuild bundle of `src/`. It is committed because the Claude Code plugin runs straight from the git checkout (`hooks/hooks.json` calls `${CLAUDE_PLUGIN_ROOT}/bin/wg`). CI fails on `git diff --exit-code -- bin/wg`, so rebuild and commit it with any `src/` change.

Tests exercise the built binary, not the TypeScript: `test/helpers.ts` spawns `bin/wg` against throwaway git repos (`makeRepo`), and `test/global-setup.ts` rebuilds before the run.

## Versions

`package.json` is the source of truth. `.claude-plugin/plugin.json` and `marketplace.json` must carry the same version (`test/versions.test.ts`). `pnpm version` runs `scripts/sync-version.mjs`, which syncs and stages them.

## Architecture

workgate is a file-backed work item tracker (CLI `wg`) plus a Claude Code plugin that forces AI edits to go through claimed items, per-item git worktrees and a verified merge. Three entry surfaces share one core:

- `src/cli.ts`: commander definitions; thin wrappers over `src/ops.ts`.
- `src/hooks.ts`: `wg hook <session-start|user-prompt-submit|pre-tool-use|post-tool-use|session-end>`. Reads Claude Code hook JSON from stdin, emits allow/deny/context JSON. Policy lives here and in `src/guard.ts`.
- `src/statusline.ts` / `statusline-install.ts`: status line renderer and its installer.
- `skills/wg/SKILL.md`: the `/wg` skill, a front end that only shells out to the CLI.
- `skills/wg-run/SKILL.md` + `agents/wg-worker.md`: `/wg-run`, an orchestrator that hands each ready item to a fresh `wg-worker` subagent. Workers edit worktrees by absolute path from the main checkout's cwd, which is why the post-tool-use heartbeat resolves the item from a file tool's path.

Core modules:

- `src/ops.ts`: every state-changing operation (add, claim, resume, release, checkpoint, sync, done, block, drop, doctor, ...). `done` is the central flow, in three phases: under the lock, rebase onto the integration branch and check attestations; then run the config gates in a gate slot *without* the lock; then under the lock again, verify that neither branch moved, merge, close the item and remove the worktree. If the integration branch moved during the gates, it loops, up to 3 times.
- `src/items.ts`, `src/types.ts`: one markdown file with YAML frontmatter per item; zod schemas validate on every read (`ConfigSchema`, item meta). Status model: `todo | active | blocked | done | dropped`, each with required fields.
- `src/indexgen.ts`: the index file is generated, never hand-edited.
- `src/repo.ts`: resolves the repo from any worktree via `git-common-dir`. `mainRoot` is the main checkout (where `.workgate/config.json` and bookkeeping commits live); `stateDir` is `<git-common-dir>/workgate` (leases, bypass state, lock), shared by all worktrees and untracked.
- `src/state.ts`: lease heartbeats (staleness = no heartbeat within `leaseMinutes`; nothing auto-releases), bypass state, and `withLock`, a mkdir-based cross-process lock (see `test/concurrency.test.ts`). Mutations take this lock. Its owner file names a pid; it is reclaimed only when that process is gone, by atomic rename, and only the holder's token can release it. Never run long work (gates) under it: other commands give up after 30 seconds. `exclusive` is the non-waiting variant (one `wg done` per item). `withGateSlot` is the counting semaphore for gates (`gateConcurrency` slots under `<stateDir>/gates`, owned by a pid, reclaimed when that process is gone; see `test/gates.test.ts`). Gate commands run in their own process group, so an interrupted `wg done` kills the whole build (`killActiveShells`).
- `src/guard.ts`: static analysis of Bash commands to deny mutating git, and detection of writes to protected paths (item files, index, `.workgate`). Documented as a mistake guard, not a security boundary.
- `src/events.ts`: config `hooks`, user commands run after a successful add/claim/block/done/drop with the item as JSON on stdin (fired from `src/cli.ts`, outside the lock). Failures and timeouts are warnings only.
- `src/bypass.ts`: owner-only escape hatches (`[quick]` prompt prefix, `wg bypass <duration>`); the agent must be denied access to `wg bypass`.
- `src/git.ts`, `src/exec.ts`: git/process helpers. Bookkeeping commits (item and index changes) are made by the tool on the integration branch, never by the agent; `commitSuffix` is appended to their subjects.
- `src/context.ts`: the rules text and blocked/stale digest injected at session start. When flow behavior changes, update this text, `skills/wg/SKILL.md` and the README together; they describe the same rules.

Item files and the generated index are read-only for agents everywhere (hooks deny edits even inside worktrees); plan edits go through `wg body --set` and `wg plan check|uncheck`.

## Conventions

- ESM, Node >= 20, TypeScript strict. Local imports use the `.js` extension.
- Errors meant for the user are `WgError` (`src/errors.ts`).
