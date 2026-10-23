---
name: wg
description: Overview and entry point for the repo's work items (the `wg` CLI). Use on /wg to see what is open, blocked or stale, create an item, or pick one and start working on it.
---

# /wg

Front end for the `wg` CLI. All state changes go through the CLI; item files and the index are read-only (hooks deny edits everywhere); change the plan with `wg body --set` (stdin) and `wg plan check|uncheck <n>`; never run mutating git commands.

If `command -v wg` fails or the repo has no `.workgate/config.json`, say so in one line and stop (`wg init` sets a repo up).

## Arguments

- none: show the overview, then offer to pick.
- `add <title>`: create an item (step 3).
- `<id>`: show that item and offer to claim it.

## 1. Overview

Run `wg list --json` and `wg stats`. Render, in this order, at most 5 rows per group (show the group's total count and say how to see the rest):

1. Needs you: `status:blocked` (id, title, the `needs` line).
2. Stale active: `status:active` with `stale: true` (id, title, `wt`, plan progress).
3. Active: other `status:active` items.
4. Next up: `wg next --json` (bugs by severity first).

End with the counts as `blocked/open/total`.

## 2. Pick and start

Use AskUserQuestion with up to 4 options, in this priority: the top stale item (resume), the top blocked item (answer it), then the top 2 pickable items. The automatic "Other" option accepts an id.

- Blocked item chosen: show its `needs` and body, ask the user for the answer, then run `wg unblock <id> "<answer>"`.
- Stale item chosen: run `wg resume <id>`.
- Todo item chosen: run `wg claim <id>`.

`claim` and `resume` print `worktree: <path>`. Switch the session into that path (EnterWorktree with the path; if that is not possible, tell the user the path to `cd` into). Then read the item body and work from its checklist.

## 3. Create

Ask only for what is missing: title and kind (`bug|feature|rework|decision`); severity (`S1`..`S4`) for bugs; for a decision, what the owner must answer (`--needs`). Run `wg add "<title>" --kind <kind> [--sev <S>] [--needs "<text>"]`, with the body from the conversation on stdin, and print the new id. Do not claim it unless the user says to start. Use a quoted heredoc so markdown passes through literally:

```sh
wg add "Retry flaky upload" --kind bug --sev S3 <<'EOF'
Uploads over 50MB fail about 1 in 10 times with ECONNRESET.
EOF
```

To change the body of an item that has not been claimed (`todo`, or `blocked` without a branch), run `wg body <id> --set` with the new body on stdin; it replaces the whole body. A claimed item's body is edited from its worktree with `wg body --set`.

## 4. Review and statusline

- `/wg review`: run `wg review`, list unverified done items with their outcomes, and offer `wg verify <id>`.
- `/wg statusline`: explain that `wg statusline install` copies the status line script to `~/.claude/workgate/` and sets `statusLine` in the user settings; run it only after the user agrees, and use `--force` only if they accept replacing their current one.

## Rules

- Read-only requests need no item.
- Work that does not come from an existing item gets one via `wg add` before any file is edited.
- Finish with `wg done <id> ...`; do not commit, merge or push yourself.
