# Pi Conductor for Codex

The Codex sister project of [omp-conductor](https://github.com/SamiulH25/omp-conductor), adapted from its [pi-backend branch](https://github.com/SamiulH25/omp-conductor/tree/pi-backend). Codex orchestrates persistent Pi RPC workers through a local MCP server. Workers implement, investigate or review; Codex inspects reports and real diffs before merging.

The projects are maintained separately: **omp-conductor** serves Claude Code; **omp-conductor-codex** serves Codex. Shared Pi worker concepts and fixes can move between them under the MIT license. This is a standalone repository, rather than a GitHub fork tied to the original branch history. This package has no Claude runtime, React pane, Haiku call, shell stdin wrapper or Claude hook dependency.

## Install

Requires Node **22.19+**, Git, and [Pi](https://pi.dev) on PATH. The toolbox runner uses Linux `bash`, `timeout` and `flock` (matching the upstream Linux workflow).

Install the prebuilt plugin directly from GitHub:

```bash
codex plugin marketplace add SamiulH25/omp-conductor-codex --ref main
codex plugin add omp-conductor-codex@omp-conductor-codex
```

Start a new Codex session to load the tools and skill. The committed `dist/server.mjs` bundles the server dependencies; installation does not require npm or a build step.

If Pi is not installed yet:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

To install from a local checkout instead:

```bash
git clone https://github.com/SamiulH25/omp-conductor-codex.git
cd omp-conductor-codex
codex plugin marketplace add .
codex plugin add omp-conductor-codex@omp-conductor-codex
```

A minimal plugin ZIP is also available from [GitHub Releases](https://github.com/SamiulH25/omp-conductor-codex/releases). Extract it, run `codex plugin marketplace add /absolute/path/to/omp-conductor-codex`, then use the same `codex plugin add` command above. Keep API keys in your environment or local worker data directory; do not add them to this checkout.

Pi workers use OpenCode Go by default. Export `OPENCODE_GO_API_KEY` in the environment Codex starts from, or put `OPENCODE_GO_API_KEY=...` in `~/.codex/plugin-data/omp-conductor-codex/env` with mode 600. The legacy `~/.pi-workers/env` file is also read if the new file is absent. The key is passed only to Pi; it is never returned in status or reports. No OpenAI API key is needed.

The server creates its worker settings, model definition and session directories on first use. `OMP_CONDUCTOR_DATA_DIR` overrides the data directory. Its startup check probes Pi and credentials without making an inference request.

## Use

Ask Codex: “Use Pi Conductor to split this implementation into independent worker tasks, review their changes, and merge the accepted work.” The bundled `orchestrate-pi` skill covers briefing, checks and the review loop.

| Tools | Purpose |
| --- | --- |
| `pi_spawn`, `pi_send` | Start a worker or recall it with context retained |
| `pi_status`, `pi_wait`, `pi_digest` | Activity, token/cost metrics, completion and reports |
| `pi_diff`, `pi_merge` | Review real changes and merge an accepted branch |
| `pi_kill`, `pi_cleanup` | Stop work; remove an idle worker and its worktree |
| `pi_dict`, `pi_tools` | Project glossary and runnable verification checks |
| `pi_model`, `pi_effort` | Show/change settings with optional `value`; `reset` restores defaults |

`explore` and `review` workers have read-only tools. `dev` and `general` workers default to isolated worktrees in git repositories. Non-git tasks run in place with snapshots for file-tool edits. A maximum of four workers runs per server session.

Workers get a soft time warning, a partial-report request and a hard stop after a grace period. Expected-file and verification warnings remain visible in digests. Toolbox checks can serialize across workers; supervisor verification supports bounded fix rounds. Detailed investigation/review reports are preserved rather than compressed by another model.

Merges refuse tracked changes in the main checkout, abort main-checkout conflicts and hand conflicts to the worker worktree. Cleanup refuses unmerged changes unless `force: true` is explicitly used. Worktrees and the path guard are accident-prevention measures, not a security sandbox: editing workers can run shell commands as the current user. Workers do not automatically load project instruction files; include the applicable instructions in their briefs.

## State and host differences

State is stored separately from the Claude version in the Codex data directory. With `CODEX_THREAD_ID`, a restart reloads that thread's worker records and Pi session IDs. Without it, each MCP process uses a fresh UUID so separate clients do not share workers. An interrupted worker can resume through `pi_send` when its saved Pi session is available. Model, effort, dictionaries and toolboxes persist across sessions.

The Claude animated pane and automatic prompt wake-ups are replaced by `pi_status` and bounded `pi_wait`. No unsupported Codex UI hooks are installed. Follow-up tool calls are required to observe worker completion.

## Development and validation

```bash
npm ci --ignore-scripts
npm test
npm run package  # clean ZIP under artifacts/, with no node_modules or development files
```

Tests use a local fake Pi executable and real Git repositories. They cover isolated edits, recall, reviewed new-file diffs, merge/cleanup, concurrent limits, crashes, verification failures, merge conflicts, and MCP initialization/input validation. They do not spend model credits. `npm run build` type-checks TypeScript and bundles the server with esbuild.

The host-independent worker engine and Pi guard/toolbox are adapted from upstream commit `8bca6ad` under the included MIT license. Codex packaging follows [OpenAI's plugin documentation](https://developers.openai.com/plugins/build/plugins).

## Updating

Refresh the GitHub marketplace and reinstall the plugin to pick up new files, then start a new session:

```bash
codex plugin marketplace upgrade omp-conductor-codex
codex plugin add omp-conductor-codex@omp-conductor-codex
```

## Sister-project maintenance

Report Codex packaging, MCP, or runtime issues here. Report issues in the original Claude host integration to [omp-conductor](https://github.com/SamiulH25/omp-conductor). When porting a shared worker-engine fix, cite the source commit and preserve the MIT copyright notice. Neither project's working directory or release process depends on the other repository.
