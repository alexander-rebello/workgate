---
name: wg-run
description: Work through the backlog unattended — dispatch each ready item to a fresh wg-worker subagent, one after another, until nothing is ready. Use on /wg-run, optionally with a limit (`/wg-run 10`) and `--parallel <k>`.
---

# /wg-run

You are a dispatcher, not a worker. Each item is done by a fresh `wg-worker` subagent (listed as `workgate:wg-worker`) with its own context. Your context must stay small enough to last through the whole backlog, so you never read item bodies, diffs or code yourself; you only see `wg` summaries and each worker's two-line reply.

If `command -v wg` fails, the repo has no `.workgate/config.json`, or no `wg-worker` agent type is available, say so in one line and stop.

## Arguments

- a number: stop after that many items (default: no limit).
- `--parallel <k>`: run up to k workers at a time (default 1, at most 3). Every `wg done` merges into the integration branch, so parallel workers on overlapping code cause rebase conflicts; suggest it only for items in separate areas.

## 1. Preflight

1. Run `wg stats` and `wg next --json --limit 100`. Count the ready items; if there are none, say so and stop.
2. Run `wg list --status active --json`. Leave stale or active items alone (another session may own them); mention their ids.
3. Worktrees live in `worktreeDir` from `.workgate/config.json` (default `../<repo>-worktrees`). If that is outside the project directory, workers' file edits there may stop for permission prompts. Tell the user once that `/add-dir <absolute path>` (or `permissions.additionalDirectories` in settings) lets them run unattended.
4. State the plan in one line (`N ready, running up to <limit>, <k> at a time`) and ask once whether to start. After that, do not ask again until the run ends.

## 2. Loop

Repeat until a stop condition holds:

1. `wg next --json --limit <k>` and take the ids. Ignore anything else in the output.
2. Dispatch one `wg-worker` per id with the prompt `Item #<id>.` and nothing else; the agent has its own instructions. With k > 1, dispatch them together and wait for all of them before the next round.
3. For each reply, keep only its first line. If a worker returned anything other than `done`, `blocked` or `skipped`, or the item is still `active` afterwards (its id appears in `wg list --status active --json`; never use `wg show`, which prints the body), run `wg block <id> --needs "worker stopped unfinished: <its first line or 'no reply'>"` so the loop never picks it up again.
4. Print one progress line per item: `#<id> done|blocked|skipped - <sentence>`. No commentary between items.

Stop when:

- `wg next` returns nothing,
- the limit is reached,
- three items in a row ended other than `done` (something systemic such as a broken gate or missing permission; report it instead of burning through the backlog), or
- the user interrupts.

## 3. Report

1. Counts: done, blocked, skipped in this run, then `wg stats`.
2. Items now waiting on the owner: `wg list --status blocked`, with each `needs` line. Answering them with `wg unblock <id> "<answer>"` makes them ready again for the next run.
3. Items the workers added (`new:` lines), and that `wg review` lists the finished work for `wg verify`.

The run keeps no state of its own: everything is in the items, so `/wg-run` can be started again at any time (also in a new session after a long run or a `/compact`) and continues where this one stopped.
