---
name: wg
description: Overview and entry point for the repo's todo list (the `wg` CLI). Use on /wg to see what is open, blocked or stale, create a todo, or pick one and start working on it.
---

# /wg

Front end for the `wg` CLI. All state changes go through the CLI; never edit the item files by hand and never run mutating git commands.

If `command -v wg` fails or the repo has no `.workgate/config.json`, say so in one line and stop.

## Arguments

- none: show the overview, then offer to pick.
- `add <title>`: create a todo (step 3).
- `<id>`: show that item and offer to claim it.

## 1. Overview

Run `wg list --json` and `wg stats`. Render, in this order, at most 5 rows per group (show the group's total count and say how to see the rest):

1. Needs you: `status:blocked` (id, title, the `needs:` line).
2. Stale active: `status:active` with a stale heartbeat (id, title, worktree, plan progress).
3. Active: other `status:active` items.
4. Next up: pickable `status:todo` items (`wg next --json`), bugs by severity first.

End with the counts as `blocked/open/total`.

## 2. Pick and start

Use AskUserQuestion with up to 4 options, in this priority: the top stale item (resume), the top blocked item (answer it), then the top 2 pickable items. The automatic "Other" option accepts an id.

- Blocked item chosen: show its `needs:` and body, ask the user for the answer, then run `wg unblock <id> "<answer>"`.
- Stale item chosen: run `wg resume <id>`.
- Todo item chosen: run `wg claim <id>`.

`claim` and `resume` print the worktree path. Switch the session into it (EnterWorktree with that path; if that is not possible, tell the user the path to `cd` into). Then read the item body and work from its checklist.

## 3. Create

Ask only for what is missing: title and kind (`bug|feature|rework|decision`); severity (`S1`..`S4`) for bugs. Run `wg add "<title>" --kind <kind> [--sev <S>]` with the body from the conversation, and print the new id. Do not claim it unless the user says to start.

## Rules

- Read-only requests need no todo.
- Work that does not come from an existing item must get one via `wg add` before any file is edited.
- Finish with `wg done <id> ...`; do not commit, merge or push yourself.
