---
name: orchestrate-pi
description: Delegate independent implementation, investigation or review tasks to persistent Pi workers through the Pi Conductor MCP tools, review their diffs, and merge accepted work.
---

# Pi workers in Codex

Use the `omp-conductor` MCP server's `pi_*` tools. Depending on the host, tool names may have an MCP namespace prefix. Invoke workers when the user requests delegation or parallel work, or project instructions authorize it. A worker sees its standalone brief, project dictionary and toolbox; it cannot see this conversation.

## Prepare and brief

- Pick `explore` for investigation or `review` for code review. Both have a read-only tool allowlist and return full evidence-backed `FINDINGS:` reports. Pick `dev` for implementation in an isolated git worktree; `general` uses the default editing tools.
- Split implementation across disjoint files. State ownership, the outcome, relevant tests and constraints. Tell each worker other workers may be active and it must not revert their work. Include applicable project instructions: automatic context-file and skill discovery is disabled in Pi workers.
- Seed `pi_dict` (`action: set`, `entries: [{term, definition}]`) with verified project facts before a dev/general spawn. Keep test commands in `pi_tools`, not the dictionary. `noDict: true` explicitly skips this gate for a throwaway task.
- Set toolbox checks with `pi_tools` (`action: set`, `checks: [{name, command, purpose, required, serial}]`). Workers run `check <name>` themselves; serial checks share a project lock. A spawn's `checks: []` opts out for work that needs no checks.
- `pi_spawn` takes `task`, `dir`, `agent`, optional `title`, `expect`, `maxMinutes`, `checks` and `effort`. At most four workers run concurrently. `expect` identifies paths that should change.

## Review and continue

1. Wait with `pi_wait` (at most 60 seconds per call, `mode: any` or `all`). Share progress during longer work. `pi_status` gives a compact snapshot; avoid tight polling.
2. Read `pi_digest`, including warnings and check results. Read `pi_diff` before accepting changes. Summaries are worker claims; a passing check is only evidence for what it tested.
3. Use `pi_send` for a correction or next task in the same area. It retains the live process and context, or resumes the saved Pi session after idle shutdown. A stopped worker with no saved session cannot resume.
4. `pi_merge` commits worker changes and merges into the original checkout. Call it when merging is within the user's authorized scope. It refuses tracked changes in the main checkout and aborts conflicts there; a conflict is staged in the worker worktree for a follow-up fix. Review the resolution before merging again.
5. Run the relevant combined checks after merging. Add durable facts to `pi_dict` only after verification.
6. `pi_cleanup` stops the worker and removes its worktree and branch. It refuses unmerged work. Read the diff before `force: true` and use force only when discarding that work is authorized. Use `pi_kill` to stop a running worker first.

## Configuration and limits

- `pi_model` and `pi_effort`: omit `value` to show, provide a value to change, or `value: reset`. The default model is `opencode-go/deepseek-v4.1-flash`, default effort `low`. Do not change the user's model preference without their instruction. Per-worker effort overrides are supported by spawn/send.
- `verify` is an optional supervisor check run after completion. `fixRounds` (0–3) returns failures for automatic correction. Toolbox checks are the usual choice for worker-owned tests.
- Runs get a wrap-up warning near their time limit, then a partial-report request and a two-minute grace period. A timed-out worker can continue with `pi_send` and a new `maxMinutes`.
- Non-git tasks edit in place. Snapshot diffs cover edits made through file tools; shell edits have no guaranteed baseline. Prefer worktrees for editing tasks.
- Workers run with the local user's permissions. Worktrees and the path guard reduce accidental cross-worker edits; they are not OS sandboxes. Respect the session's filesystem and execution permissions.
- If setup fails, report the returned setup steps. Do not read or expose API keys. State is under `~/.codex/plugin-data/omp-conductor-codex` or `OMP_CONDUCTOR_DATA_DIR`. A stable `CODEX_THREAD_ID` restores records across MCP restarts; without one, each server starts an isolated session.
- This plugin reports completion through tool results. It has no animated Claude pane or automatic host-turn wake-up. Keep waiting until delegated work is reviewed and handled.
