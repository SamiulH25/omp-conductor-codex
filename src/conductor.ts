// Adapted from omp-conductor pi-backend (MIT). Host-independent worker engine.
import { atom, read, update, type Register } from './runtime.js'

type Act = 'think' | 'read' | 'edit' | 'bash' | 'tool'

const MAX_WORKERS = 4
const MAX_EVENTS = 300
const FINAL_CHARS = 700
const FILE_LIMIT = 12
const ROOTS_EXTRA = ['/tmp']
const DENY = /\/\.(ssh|gnupg|aws|kube|docker)(\/|$)/
// Workers are Pi (https://pi.dev) RPC processes: one long-lived `pi --mode rpc` per worker, so a worker keeps
// what it learned and can be recalled for fixes. They run in their own Pi agent dir (own prompt, models, sessions).
// The only model workers ever use. pi_model changes it and the choice is kept in the store.
const DEFAULT_MODEL = 'opencode-go/deepseek-v4.1-flash'
const DEFAULT_THINKING = 'low' // reasoning effort workers start with; pi_effort changes it
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] // pi --thinking values
const AGENT_DIR_NAME = '.pi-workers' // under $HOME: PI_CODING_AGENT_DIR for every worker
const KEY_VARS = ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'] // OpenCode Go key: env file in the agent dir, or the environment
const SOFT_FRACTION = 0.85 // at this share of the time limit the worker is told to wrap up
const GRACE_MS = 2 * 60 * 1000 // after the limit the worker gets this long to write its partial report before it is stopped
const VERIFY_TAIL = 1500 // chars of a failing verify command's output kept for the digest and the fix prompt
const JUNK = ['Library', 'Temp', 'obj', 'Logs', 'node_modules', '.git', '__pycache__', 'Builds'] // skipped when listing changes in a non-git dir
const IDLE_STOP_MS = 30 * 60 * 1000 // an idle worker's Pi process is stopped after this; pi_send resumes its session
const STORE_PREFIX = 'workers:' // one store key per Codex session, so sessions never share records
// Avatar reactions: how long a one-shot reaction shows, and which tools count as reading or editing.
const REACT_MS = { error: 1800, write: 1200, turn: 700 } as const
const REACT_RANK = { error: 3, write: 2, turn: 1 } as const
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
const SYNC_MS = 250 // minimum gap between state saves triggered by worker output
const STALE_MS = 14 * 24 * 3600 * 1000
// Project dictionary: short term -> definition entries per project root, kept in the store, injected into every worker.
const DICT_PREFIX = 'dict:'
const DICT_MAX_CHARS = 6000 // whole dictionary; keeps the injected context small
const DICT_DEF_CHARS = 300 // one definition; a dictionary entry, not an essay
// Project toolbox: the checks (tests, compile, lint) workers are expected to run themselves, with the `check` command
// from bin/. Kept per project root in the store; a Unity project with none set gets UNITY_TOOLS.
const TOOLS_PREFIX = 'tools:'
type Check = {
  command: string // bash, run from the project root (the worker's worktree root when it has one)
  purpose: string
  required: boolean // must pass after the worker's last edit, before it reports
  serial: boolean // one run at a time across all workers of the project (a tool that locks the project)
  timeoutSec: number
  report?: string // NUnit/JUnit XML the command writes; failed tests are listed from it ($TMPDIR allowed)
  log?: string // extra log the command writes, searched for error lines on a failure
  highlight?: string // regex for the error lines worth showing from the output on a failure
  retryIf?: string // regex: on a failure whose output matches, wait and retry (a capture group 1 PID: only while it is a batch run)
}
const CHECK_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/
const UNITY_HIGHLIGHT = 'error CS\\d+|compiler errors|already open in a running Editor|another Unity instance|FAILED|Exception|TEST_|did not complete|aborting'
const UNITY_BUSY = 'already open in a running Editor \\(PID (\\d+)\\)'
const UNITY_TOOLS: Record<string, Check> = {
  'unity-compile': {
    // A filter that matches no test: the editor compiles every assembly and stops (about 20 s; 5 s on an error).
    command: 'unity test . --mode EditMode --filter "Omp.Conductor.NoTest" --output "$TMPDIR/compile.xml" --non-interactive --no-banner -- -logFile "$TMPDIR/unity-compile.log"',
    purpose: 'compiles every assembly (runtime, editor, tests) in a headless Unity editor and lists each error CS#### with file:line. Fast (~20 s): run it after each batch of edits',
    required: true,
    serial: true,
    timeoutSec: 600,
    log: '$TMPDIR/unity-compile.log',
    highlight: UNITY_HIGHLIGHT,
    retryIf: UNITY_BUSY,
  },
  'unity-editmode': {
    command: 'unity test . --mode EditMode {args} --output "$TMPDIR/editmode.xml" --non-interactive --no-banner -- -logFile "$TMPDIR/unity-editmode.log"',
    purpose: 'runs the EditMode tests headless and lists failed tests with messages. The full suite takes minutes, so pass a filter for the tests your change touches: check unity-editmode --filter "Namespace.TestClass" (several: "A;B"). The supervisor runs the full suite after merging',
    required: true,
    serial: true,
    timeoutSec: 1200,
    report: '$TMPDIR/editmode.xml',
    log: '$TMPDIR/unity-editmode.log',
    highlight: UNITY_HIGHLIGHT,
    retryIf: UNITY_BUSY,
  },
  'unity-playmode': {
    command: 'unity test . --mode PlayMode {args} --output "$TMPDIR/playmode.xml" --non-interactive --no-banner -- -noaudio -logFile "$TMPDIR/unity-playmode.log"',
    purpose: 'runs the PlayMode tests headless (slow); run it, filtered like unity-editmode, when you changed runtime behaviour that PlayMode tests cover',
    required: false,
    serial: true,
    timeoutSec: 1500,
    report: '$TMPDIR/playmode.xml',
    log: '$TMPDIR/unity-playmode.log',
    highlight: UNITY_HIGHLIGHT,
    retryIf: UNITY_BUSY,
  },
}

// First-run files for the worker agent dir, written only when missing so the user's edits stay.
const WORKER_PROMPT = `You are a worker subagent. An orchestrator gave you one task in a project directory; do it and report back.

Rules:
- Read each file once. Do not re-read a file or re-run a command whose output you already have; use what is in context.
- Prefer grep to locate code, then read only the part you need.
- Make the smallest change that completes the task. Do not touch unrelated files, commit, or push.
- Use tool calls only for work. Do not narrate or restate the task.
- You may be recalled later in this same session for fixes. Keep what you learned about the codebase; do not re-explore it.
- Finish with a short report: \`SUMMARY:\` then what changed or was found, with file:line references. State anything you could not verify.
`
const WORKER_SETTINGS = {
  defaultProvider: 'opencode-go',
  defaultModel: 'deepseek-v4.1-flash',
  defaultThinkingLevel: DEFAULT_THINKING,
  defaultTools: ['read', 'edit', 'write', 'bash', 'grep'],
  quietStartup: true,
}
const WORKER_MODELS = {
  providers: {
    'opencode-go': {
      baseUrl: 'https://opencode.ai/zen/go/v1',
      api: 'openai-completions',
      apiKey: '$OPENCODE_GO_API_KEY',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (Go)', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 65536 },
      ],
    },
  },
}
const SETUP_HELP = `omp-conductor workers run on Pi, and Pi is not ready:
{problems}
Set up (once):
  1. Install Pi (needs Node 22.19+): npm install -g --ignore-scripts @earendil-works/pi-coding-agent   (or: curl -fsSL https://pi.dev/install.sh | sh)
  2. Put your OpenCode Go key where the plugin can read it: echo 'OPENCODE_GO_API_KEY=<your key>' > {dataDir}/env && chmod 600 {dataDir}/env   (or export OPENCODE_GO_API_KEY in the environment Codex starts from)
  3. Restart Codex, or just ask for a worker again: while Pi is not ready the check re-runs on every spawn, so no restart is needed.
The plugin creates {dataDir}/ (worker prompt, models, sessions) by itself; nothing else needs configuring.`

// The worker simplifies its own work: every task ends with a SUMMARY block the digest quotes.
const SUFFIX =
  '\n\n---\nWhen you are finished, end your final reply with a block starting with the line "SUMMARY:" followed by at most 5 short bullets: what you did, files created or changed, anything that failed or was skipped, open questions. Plain text, under 120 words.'
const SUMMARY_RE = /(?:^|\n)[#*\s]*SUMMARY:?[*\s]*\n?([\s\S]*)$/

// Agent types: what a worker may do (a hard --tools allowlist plus a stated role) and how it reports back.
// 'summary' types condense their own work; 'detailed' types return the full report and are never compressed.
type AgentType = {
  about: string
  tools?: string[] // pi --tools allowlist; undefined = the agent dir's defaultTools
  worktree: boolean | 'auto' // default isolation ('auto' = a worktree when dir is a git repo)
  report: 'summary' | 'detailed'
  maxMinutes: number
  role: string // appended to the system prompt: states the permissions and working style
  suffix: string // appended to the task: how to end the final reply
}

const WORKER_RULES =
  ' EDITING: make ONE edit per edit call (never batch several in one call); copy oldText exactly from a fresh read of that region; if an edit fails, re-read the region and retry that single edit. Never fall back to python/sed/heredoc rewrites of source files. TESTING: if your prompt has a TOOLBOX, those checks are yours to run with `check <name>`; run them, do not reason your way out of them. Otherwise run the check the task names. Never build a substitute harness or checker anywhere (no stub projects, no reimplemented engine APIs, no copied DLLs): if a real check cannot run (missing tool, project locked, timeout), make the change, check it by reading, and report the exact error and that it is unverified. SCRATCH: put any scratch file in $TMPDIR, never in the project and never in /tmp directly. OTHERS: other workers may be editing other files in this project at the same time; compile errors in files you did not touch belong to them, so do not fix or work around them. Stay on the task: if you finish without changing the files you were asked to change, say so and why.'
const READ_ONLY = ['read', 'grep', 'find', 'ls']
const READ_ONLY_ROLE =
  'PERMISSIONS: read-only. You can read, search and list files; you cannot and must not modify, create or delete anything, run builds or change any state. Your tools are restricted accordingly; do not try to work around that. If the task needs a change, describe the change and where it belongs instead of making it.'
const DETAILED_RULES =
  'Your supervisor cannot see what you looked at, so the report is the only thing it gets. Do NOT condense it: length is fine, omission is not. Mark every claim as verified (you read it) or inferred.'

const AGENTS: Record<string, AgentType> = {
  general: {
    about: 'unrestricted, short SUMMARY (the pre-agent-types behaviour)',
    worktree: 'auto',
    report: 'summary',
    maxMinutes: 20,
    role: `You are a general worker.${WORKER_RULES}`,
    suffix: SUFFIX,
  },
  dev: {
    about: 'implements changes: read, edit, write, shell; short SUMMARY of what changed. Worktree by default',
    tools: [...READ_ONLY, 'edit', 'write', 'bash'],
    worktree: 'auto',
    report: 'summary',
    maxMinutes: 20,
    role: 'You are a dev agent. PERMISSIONS: you may read, edit and create files and run shell commands, only inside the working directory and only for what the task asks. Do not touch unrelated files, do not install global packages, do not run git commit, push, checkout or reset (the supervisor commits and merges), and do not delete anything outside the task. Verify your work before you finish: with your TOOLBOX checks if you have any, and with the tests or checks named in the task.' + WORKER_RULES,
    suffix: SUFFIX,
  },
  explore: {
    about: 'read-only investigator: finds and reads code, returns a long evidence-backed FINDINGS report (never summarized). No worktree',
    tools: READ_ONLY,
    worktree: false,
    report: 'detailed',
    maxMinutes: 15,
    role: `You are an explore agent. ${READ_ONLY_ROLE} METHOD: be exhaustive. Follow references and call chains to the end, try several naming conventions and search terms before concluding something is absent, and read the actual code rather than guessing from file names. Cite file:line for every claim.`,
    suffix: `\n\n---\nWhen you are finished, end your final reply with a block starting with the line "FINDINGS:" holding your complete report: every relevant file with line numbers, short code or signatures quoted verbatim, how the pieces connect, what you searched for and did not find, and open questions or uncertainty. ${DETAILED_RULES}`,
  },
  review: {
    about: 'read-only reviewer: returns every issue found with file:line, severity and a fix (never summarized). No worktree',
    tools: READ_ONLY,
    worktree: false,
    report: 'detailed',
    maxMinutes: 15,
    role: `You are a review agent. ${READ_ONLY_ROLE} METHOD: read the code under review in full and check each claim against what it actually does. Look for correctness bugs, unhandled edge cases, broken contracts with callers, and missing tests. Do not pad with style nitpicks.`,
    suffix: `\n\n---\nWhen you are finished, end your final reply with a block starting with the line "FINDINGS:" listing every issue, most severe first. For each: severity (high/medium/low), file:line, what is wrong, a concrete failure scenario, and a suggested fix. Then list what you checked that was fine. ${DETAILED_RULES}`,
  },
}
const DEFAULT_AGENT = 'general'
const REPORT_CHARS = 60000 // a detailed report is shown whole; this is only a runaway guard (~15k tokens)
const REPORT_CHARS_FULL = 200000 // ... with detail:"full", and the most the store keeps

// Everything the session has spent on workers, kept even after a worker is cleaned up.

type State = 'running' | 'done' | 'failed' | 'killed'

type Worker = {
  id: string
  title: string
  task: string
  dir: string
  root: string // git toplevel, or dir outside git; keys the project dictionary
  isGit: boolean
  worktree?: string
  sub?: string // dir's path inside the repo (e.g. /packages/api); the worker starts at the same place in its worktree
  branch?: string
  summary?: string
  session?: string
  model?: string
  agent: string
  act?: Act
  lastAt?: number // last worker event, used for quiet-time reporting
  react?: { kind: keyof typeof REACT_MS; at: number }
  reads: Set<string>
  state: State
  startedAt: number
  endedAt?: number
  files: Set<string>
  commands: string[]
  errors: string[]
  texts: string[]
  events: string[]
  last: string
  steps: number
  tokensIn: number
  tokensOut: number
  stderr: string
  isReported: boolean
  stop?: () => void // ends the worker's Pi process
  send?: (cmd: Record<string, unknown>) => Promise<void> // writes one RPC command to it
  timer?: { cancel: () => void } // the run's time limit
  runError?: string // set when the run ended in a provider error or hit the time limit
  killed?: boolean
  firstAt?: number // first streamed delta of the turn, for the decode-speed fallback
  live?: string // tail of what the model is thinking or writing right now; shown as the card's activity
  soft?: { cancel: () => void } // 'wrap up' timer
  grace?: { cancel: () => void } // hard stop after the limit, once the partial report had its chance
  timedOut?: boolean
  verify?: string // command the plugin runs itself after the worker finishes (serialized across workers)
  verifyTimeout?: number
  fixesLeft?: number // automatic fix rounds: a failing verify is sent back to the worker this many times
  verifying?: boolean
  verifyDone?: boolean
  verifyResult?: { ok: boolean; exit: number; tail: string }
  warn: string[] // things the supervisor must not miss: no changes made, expected files untouched, verify failed
  expect?: string[] // paths (relative to dir) the task must change
  checks?: string[] // toolbox checks this worker must run (and pass) after its last edit
  checkRuns?: { name: string; ok: boolean; exit: number; secs: number }[] // the `check` runs of the last run, oldest first
  effort?: string // per-worker reasoning effort override
  effortSent?: string
  marker?: string // non-git dirs: file whose mtime marks the spawn, for 'changed since' listings
  snapDir?: string // non-git dirs: originals of files the worker edited (written by the guard extension)
  tokensCache: number
  waitSteps?: number // pi_wait reports running workers as deltas against these
  waitFiles?: number
  tps?: number
  tpsAt?: number
  outTokens: number
  genMs: number
  spark: number[]
  maxMinutes?: number
  cost: number
  sawEnd: boolean
  turnChars: number
  ratio: number
  win: [number, number][]
  toolArgs: Record<string, Record<string, unknown>>
}

type Bridge = {
  sync: () => Promise<void>
  syncSoon: () => void
  launch: (w: Worker, message: string) => void
  finished: (w: Worker) => Promise<void>
  verify: (w: Worker) => Promise<void>
  changed: (w: Worker) => Promise<string[] | undefined>
  nonGitDiff: (w: Worker, cap: number) => Promise<string>
  summarize: (text: string) => Promise<string | undefined>
  git: (
    args: string[],
    cwd: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string } | undefined>
  realPath: (dir: string) => Promise<string | undefined>
  ledger: (cost: number, tokens: number, spawned: number) => Promise<void>
}

const text = (s: string, isError = false) => (isError ? { deny: s } : { result: s })

const money = (c: number) => (c <= 0 ? 'plan' : `$${c >= 1 ? c.toFixed(2) : c >= 0.01 ? c.toFixed(3) : c.toFixed(4)}`)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const one = (s: string) => s.replace(/\s+/g, ' ').trim()
const ownSummary = (w: Worker) => {
  for (let i = w.texts.length - 1; i >= 0; i--) {
    const m = SUMMARY_RE.exec(w.texts[i]!)
    if (m && m[1]!.trim()) return m[1]!.trim()
  }
  return undefined
}
const elapsed = (w: Worker) => {
  const sec = Math.round(((w.endedAt ?? Date.now()) - w.startedAt) / 1000)
  return sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`
}

export const register: Register = on => {
  const ledgerAtom = atom({ plugin: 'omp-conductor', key: 'ledger' } as const, { cost: 0, tokens: 0, spawned: 0 })
  const workers = new Map<string, Worker>()
  let B: Bridge | undefined
  let cwd = ''
  let home = ''
  let currentModel = DEFAULT_MODEL
  let currentThinking = DEFAULT_THINKING
  let agentDir = ''
  let apiKey = ''
  let sid = ''
  let hostPath = ''
  let ensureSetup: () => Promise<string | undefined> = async () => undefined
  let setupProblems: string[] = ['setup not checked yet']
  const roots = () => [cwd, home, ...ROOTS_EXTRA]
  let seq = 0

  const running = () => [...workers.values()].filter(w => w.state === 'running').length

  const sync = () => B?.sync() ?? Promise.resolve()

  const workDir = (w: Worker) => (w.worktree ? `${w.worktree}${w.sub ?? ''}` : w.dir)

  // A run is over (Pi settled, the process died, it was killed or hit its time limit). The process may stay up.
  const finish = (w: Worker) => {
    if (w.state !== 'running') return
    w.timer?.cancel()
    w.timer = undefined
    w.soft?.cancel()
    w.soft = undefined
    w.grace?.cancel()
    w.grace = undefined
    if (w.timedOut && !w.killed && !w.runError) {
      w.runError = `time limit (${w.maxMinutes ?? 20}m) reached; the worker was asked for a partial report (its last message)`
      w.errors.push(w.runError)
    }
    const next = w.killed ? 'killed' : w.runError ? 'failed' : 'done'
    // A verify command runs before the worker counts as done; a failure can go back to the worker as a fix round.
    if (next === 'done' && w.verify && !w.verifyDone) {
      if (w.verifying) return
      w.verifying = true
      w.act = 'bash'
      w.last = `verifying: ${clip(one(w.verify), 60)}`
      void B?.verify(w)
      return
    }
    w.endedAt = Date.now()
    w.state = next
    void B?.finished(w)
  }

  // ---------------------------------------------------------------- parsing
  const note = (w: Worker, line: string) => {
    w.events.push(clip(one(line), 200))
    if (w.events.length > MAX_EVENTS) w.events.shift()
  }

  const actOf = (tool: string): Act => {
    const t = tool.toLowerCase()
    return READ_TOOLS.has(t) ? 'read' : FILE_TOOLS.has(t) ? 'edit' : t === 'bash' ? 'bash' : 'tool'
  }

  // A one-shot reaction; a stronger one is not replaced by a weaker one while it is still showing.
  const react = (w: Worker, kind: keyof typeof REACT_MS) => {
    const cur = w.react
    if (cur && Date.now() - cur.at < REACT_MS[cur.kind] && REACT_RANK[cur.kind] > REACT_RANK[kind]) return
    w.react = { kind, at: Date.now() }
  }

  const target = (input: Record<string, unknown> | undefined) => {
    const v = input?.path ?? input?.filePath ?? input?.file_path ?? input?.file
    return typeof v === 'string' ? v : undefined
  }

  const FILE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit', 'ast_edit', 'notebook'])
  const WINDOW_MS = 2500

  // Live speed: characters streamed in the last couple of seconds, turned into tokens with a
  // ratio the previous turns calibrated against Pi's own usage numbers.
  const liveTps = (w: Worker, now: number) => {
    w.win = w.win.filter(([t]) => t >= now - WINDOW_MS)
    if (!w.win.length) return undefined
    const chars = w.win.reduce((n, [, c]) => n + c, 0)
    const span = Math.max(600, now - w.win[0]![0])
    return (chars * w.ratio) / (span / 1000)
  }

  const ingest = (w: Worker, raw: string) => {
    let ev: any
    try {
      ev = JSON.parse(raw)
    } catch {
      // Pi prints plain-text errors (unknown model, bad flag) outside the JSON stream.
      w.stderr = (w.stderr + raw + '\n').slice(-2000)
      note(w, `raw: ${raw}`)
      return
    }
    w.lastAt = Date.now()
    switch (ev.type) {
      case 'response':
        // The reply to get_state (sent once after start) carries the id pi_send resumes with.
        if (ev.command === 'get_state' && ev.success && typeof ev.data?.sessionId === 'string') w.session = ev.data.sessionId
        else if (ev.success === false && ev.command !== 'get_state') {
          w.runError = clip(one(String(ev.error ?? `${ev.command} failed`)), 200)
          w.errors.push(`${ev.command}: ${w.runError}`)
        }
        break
      case 'turn_start':
        w.turnChars = 0
        w.firstAt = undefined
        w.live = ''
        w.act = 'think'
        w.last = 'thinking'
        break
      case 'message_update': {
        const a = ev.assistantMessageEvent ?? {}
        if (
          typeof a.delta === 'string' &&
          (a.type === 'text_delta' || a.type === 'toolcall_delta' || a.type === 'thinking_delta')
        ) {
          w.turnChars += a.delta.length
          w.firstAt ??= Date.now()
          w.win.push([Date.now(), a.delta.length])
          // The card's activity follows the model: what it is thinking, what it is writing, which tool call it is composing.
          if (a.type !== 'toolcall_delta') {
            const kind = a.type === 'thinking_delta' ? 'thinking' : 'writing'
            w.act = a.type === 'thinking_delta' ? 'think' : 'edit'
            w.live = ((w.live ?? '') + a.delta).slice(-240)
            const tail = one(w.live)
            w.last = `${kind}: ${tail.length > 70 ? `…${tail.slice(-69)}` : tail}`
          }
        } else if (a.type === 'thinking_start' || a.type === 'text_start') {
          w.live = ''
          w.act = a.type === 'thinking_start' ? 'think' : 'edit'
          w.last = a.type === 'thinking_start' ? 'thinking' : 'writing'
        } else if (a.type === 'toolcall_start') {
          w.act = 'tool'
          w.last = `preparing ${String(a.toolName ?? 'tool call')}`
        } else if (a.type === 'text_end' && typeof a.content === 'string' && a.content) {
          w.texts.push(a.content)
          note(w, `text ${a.content}`)
        }
        break
      }
      case 'tool_execution_start': {
        const args = (ev.args ?? {}) as Record<string, unknown>
        w.toolArgs[String(ev.toolCallId)] = args
        w.act = actOf(String(ev.toolName ?? ''))
        w.last = clip(one(`▶ ${ev.toolName} ${ev.intent ?? target(args) ?? args.command ?? ''}`), 80)
        break
      }
      case 'tool_execution_end': {
        const tool = String(ev.toolName ?? 'tool')
        const args = w.toolArgs[String(ev.toolCallId)] ?? {}
        delete w.toolArgs[String(ev.toolCallId)]
        const file = target(args)
        const out = ((ev.result?.content ?? []) as { text?: string }[]).map(c => c?.text ?? '').join('')
        const name = tool.toLowerCase()
        if (file && !ev.isError && (FILE_TOOLS.has(name) || name === 'read')) {
          const base = `${workDir(w)}/`
          ;(name === 'read' ? w.reads : w.files).add(file.startsWith(base) ? file.slice(base.length) : file)
        }
        const cmd = typeof args.command === 'string' ? args.command : undefined
        if (name === 'bash' && cmd) {
          w.commands.push(cmd)
          const exit = ev.result?.details?.exitCode ?? /exit(?:ed)?(?: with)?(?: code)?[: ]+(\d+)/i.exec(out)?.[1]
          if (exit != null && Number(exit) !== 0) {
            w.errors.push(`bash exit ${exit}: ${clip(one(cmd), 80)}`)
            react(w, 'error')
          }
        }
        w.last = clip(one(`${tool} ${file ?? cmd ?? ''}`), 80)
        w.act = 'think'
        if (file && !ev.isError && FILE_TOOLS.has(name)) react(w, 'write')
        if (ev.isError) {
          react(w, 'error')
          const msg = clip(one(out || 'error'), 200)
          w.errors.push(`${tool}: ${msg}`)
          note(w, `ERR ${tool} ${msg}`)
        } else note(w, `${tool} ${file ?? clip(cmd ?? '', 80)}`)
        break
      }
      case 'turn_end': {
        const m = ev.message ?? {}
        const u = m.usage ?? {}
        const gen = Number(u.output ?? 0)
        w.steps += 1
        w.tokensIn += Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0)
        w.tokensCache += Number(u.cacheRead ?? 0)
        w.tokensOut += gen
        const cost = Number(u.cost?.total ?? 0)
        w.cost += cost
        void B?.ledger(cost, Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0) + gen, 0)
        // Exact decode speed for the turn: generated tokens over time after the first token.
        const decodeMs = m.duration != null ? Number(m.duration) - Number(m.ttft ?? 0) : w.firstAt ? Date.now() - w.firstAt : 0
        if (gen > 0 && decodeMs >= 150) {
          w.tps = gen / (decodeMs / 1000)
          w.tpsAt = Date.now()
          w.outTokens += gen
          w.genMs += decodeMs
          w.spark.push(Math.round(w.tps))
          if (w.spark.length > 12) w.spark.shift()
        }
        if (gen > 0 && w.turnChars > 20) w.ratio = 0.5 * w.ratio + 0.5 * (gen / w.turnChars)
        w.win = []
        react(w, 'turn')
        break
      }
      case 'message_end': {
        const m = ev.message ?? {}
        if (m.role === 'assistant' && (m.stopReason === 'error' || m.stopReason === 'aborted')) {
          const why = clip(one(String(m.errorMessage ?? m.stopReason)), 200)
          if (m.stopReason === 'error' || (m.stopReason === 'aborted' && !w.killed && !w.runError)) {
            w.runError = m.stopReason === 'aborted' ? 'aborted by Pi' : why
            w.errors.push(`model: ${w.runError}`)
            react(w, 'error')
          }
        }
        break
      }
      case 'agent_end':
        w.sawEnd = true
        break
      case 'agent_settled':
        // Pi will do nothing more on its own: the run is over, the process stays up for the next prompt.
        finish(w)
        break
      default:
        break
    }
  }

  // ---------------------------------------------------------------- digest
  const digest = async (w: Worker, full = false) => {
    const lines: string[] = []
    const kind = AGENTS[w.agent] ?? AGENTS[DEFAULT_AGENT]!
    lines.push(`[${w.id}] ${w.title} — ${w.state} (${elapsed(w)}) ${w.agent} session=${w.session ?? '?'}`)
    lines.push(`dir: ${workDir(w)}${w.worktree ? ' (worktree)' : ''}`)
    const files = [...w.files]
    if (files.length) {
      lines.push(
        `wrote/edited ${files.length}: ${files.slice(0, FILE_LIMIT).join(', ')}${files.length > FILE_LIMIT ? ', …' : ''}`,
      )
    }
    if (kind.report === 'detailed' && w.reads.size) lines.push(`read ${w.reads.size} file${w.reads.size === 1 ? '' : 's'}`)
    if (w.commands.length) {
      lines.push(
        `commands ${w.commands.length}, last: ${w.commands
          .slice(-4)
          .map(c => clip(one(c), 70))
          .join(' | ')}`,
      )
    }
    if (w.isGit) {
      const st = await B?.git(['status', '--short'], workDir(w))
      const out = st?.stdout.trim()
      if (out) {
        const rows = out.split('\n')
        lines.push(`git status (${rows.length}): ${rows.slice(0, FILE_LIMIT).join('; ')}`)
      }
    }
    if (w.errors.length) {
      lines.push(`errors ${w.errors.length}: ${w.errors.slice(-3).join(' | ')}`)
    }
    if (w.state !== 'running' && w.stderr.trim()) lines.push(`stderr: ${clip(one(w.stderr), 300)}`)
    const avg = w.genMs > 0 ? `, ~${Math.round(w.outTokens / (w.genMs / 1000))} tok/s` : ''
    lines.push(`steps ${w.steps}, tokens in ${w.tokensIn} (cached ${w.tokensCache}) / out ${w.tokensOut}${avg}, cost ${money(w.cost)}${w.cost <= 0 ? ' (flat-rate plan, no per-token price)' : ''}`)
    for (const x of w.warn) lines.push(`⚠ ${x}`)
    if (w.checkRuns?.length) lines.push(`checks run: ${w.checkRuns.map(c => `${c.name} ${c.ok ? 'PASS' : `FAIL(${c.exit})`} ${c.secs}s`).join(', ')}`)
    else if (w.checks?.length && w.state !== 'running') lines.push(`checks run: none (required: ${w.checks.join(', ')})`)
    if (w.verifyResult) lines.push(`verify ${w.verifyResult.ok ? 'PASSED' : `FAILED (exit ${w.verifyResult.exit})`}: ${w.verify}${w.verifyResult.ok ? '' : `\n${w.verifyResult.tail}`}`)
    const final = w.texts.at(-1)?.trim()
    const own = ownSummary(w)
    // Mid-run the last message is usually an opening line from many steps ago: show the live activity instead.
    if (w.state === 'running') {
      lines.push(`now: ${w.last} (no final message yet)`)
    } else if (kind.report === 'detailed' && final) {
      // Explore and review agents: the whole report, never compressed.
      const cap = full ? REPORT_CHARS_FULL : REPORT_CHARS
      lines.push(`report${final.length > cap ? ` (first ${cap} of ${final.length} chars; detail:"full" for more)` : ''}:`, clip(final, cap))
    } else if (own) {
      lines.push(`summary (worker's own): ${clip(own, 800)}`)
    } else if (final && final.length > FINAL_CHARS && !full) {
      w.summary ??= await B?.summarize(final)
      lines.push(
        w.summary ? `summary: ${w.summary}` : `final: ${clip(final, FINAL_CHARS)}`,
      )
    } else if (final) {
      lines.push(`final: ${clip(final, full ? 4000 : FINAL_CHARS)}`)
    } else lines.push(`last action: ${w.last || 'none yet'}`)
    if (full && own && final && kind.report !== 'detailed') lines.push(`full final: ${clip(final, 4000)}`)
    if (full) lines.push('--- events ---', ...w.events.slice(-60))
    return lines.join('\n')
  }

  const insideRoots = async (dir: string) => {
    const real = await B?.realPath(dir)
    if (!real) return false
    if (DENY.test(real)) return false
    return roots().some(r => r && (real === r || real.startsWith(`${r}/`)))
  }

  const pick = (e: Record<string, unknown>) => {
    const id = typeof e.id === 'string' ? e.id : ''
    return workers.get(id)
  }

  // The project's toolbox: what the supervisor set with pi_tools, else the built-in Unity checks for a Unity project
  // (at the repo root or at dir inside it). `sub` is where the Unity project sits inside the root.
  type Toolbox = { checks: Record<string, Check>; source: 'set' | 'unity default' | 'none'; sub: string }
  const loadTools = async ($: any, root: string, dir: string): Promise<Toolbox> => {
    const real = ((await B?.realPath(dir)) ?? dir).replace(/\/+$/, '')
    let unity: string | undefined
    for (const p of real === root || !real.startsWith(`${root}/`) ? [root] : [real, root]) {
      if (await $.fs.exists(`${p}/ProjectSettings/ProjectVersion.txt`).catch(() => false)) {
        unity = p.slice(root.length)
        break
      }
    }
    // A stored toolbox wins, even an empty one (every check removed on purpose); reset brings back the default.
    const set = (await $.store.get(TOOLS_PREFIX + root).catch(() => undefined)) as Record<string, Check> | undefined
    if (set && typeof set === 'object') return { checks: set, source: 'set', sub: unity ?? '' }
    if (unity !== undefined) return { checks: UNITY_TOOLS, source: 'unity default', sub: unity }
    return { checks: {}, source: 'none', sub: '' }
  }
  const toolsText = (t: Toolbox) =>
    Object.entries(t.checks)
      .map(([n, c]) => `- ${n}${c.required ? ' (required)' : ''}${c.serial ? ' [serial]' : ''}: ${c.purpose}\n    runs: ${c.command}`)
      .join('\n')

  // ---------------------------------------------------------------- hooks
  on('session.start', async ($, e, next) => {
    cwd = (e as { cwd?: string }).cwd ?? ''
    home = $.home
    agentDir = $.dataDir
    sid = String(await $.session.id())
    hostPath = (await $.process.run(['printenv', 'PATH']).catch(() => undefined))?.stdout.trim() ?? ''
    await $.fs.write(`${agentDir}/locks/.keep`, '').catch(() => undefined)
    // A checkout or a zip can lose the exec bit of the `check` runner workers call.
    void $.process.run(['chmod', '+x', `${$.plugin.root}/bin/check`], { timeoutMs: 5000 }).catch(() => undefined)

    // Pi must be installed and the OpenCode Go key present. Create the agent dir's files if missing, then check.
    const checkSetup = async (): Promise<string[]> => {
      const problems: string[] = []
      const v = await $.process.run(['pi', '--version'], { timeoutMs: 15_000 }).catch(() => undefined)
      if (!v || v.exitCode !== 0) problems.push('- `pi` is not installed or not on PATH (Codex must be started from a shell where `pi --version` works)')
      for (const [name, body] of [
        ['SYSTEM.md', WORKER_PROMPT],
        ['settings.json', `${JSON.stringify(WORKER_SETTINGS, null, 2)}\n`],
        ['models.json', `${JSON.stringify(WORKER_MODELS, null, 2)}\n`],
      ] as const) {
        const path = `${agentDir}/${name}`
        if (!(await $.fs.exists(path).catch(() => false))) await $.fs.write(path, body).catch(() => undefined)
      }
      apiKey = ''
      const envText = await $.fs.read(`${agentDir}/env`).catch(() => $.fs.read(`${home}/.pi-workers/env`).catch(() => undefined))
      for (const line of typeof envText === 'string' ? envText.split('\n') : []) {
        const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
        if (m && KEY_VARS.includes(m[1]!)) apiKey ||= m[2]!.replace(/^(['"])(.*)\1$/, '$2')
      }
      for (const k of KEY_VARS) {
        if (apiKey) break
        apiKey = (await $.process.run(['printenv', k]).catch(() => undefined))?.stdout.trim() ?? ''
      }
      if (!apiKey) problems.push(`- no OpenCode Go key found (looked in ${agentDir}/env and the environment for ${KEY_VARS.join(' or ')})`)
      return problems
    }
    ensureSetup = async () => {
      if (!setupProblems.length) return undefined
      setupProblems = await checkSetup()
      return setupProblems.length ? SETUP_HELP.replaceAll('{dataDir}', agentDir).replace('{problems}', setupProblems.join('\n')) : undefined
    }
    // Command files of workers whose session is long gone (a stop at shutdown can lose its rm).
    setupProblems = await checkSetup()
    let syncTimer: { cancel: () => void } | undefined

    currentModel = String((await $.store.get('model').catch(() => undefined)) || DEFAULT_MODEL)
    const savedThinking = String((await $.store.get('thinking').catch(() => undefined)) || DEFAULT_THINKING)
    currentThinking = THINKING_LEVELS.includes(savedThinking) ? savedThinking : DEFAULT_THINKING
    let lastSig = ''
    let verifyChain: Promise<unknown> = Promise.resolve() // verify commands run one at a time (a locked editor cannot run two)
    const storeKey = `${STORE_PREFIX}${await $.session.id()}`
    const record = (w: Worker) => ({
      id: w.id,
      title: w.title,
      task: clip(w.task, 500),
      dir: w.dir,
      root: w.root,
      isGit: w.isGit,
      worktree: w.worktree,
      sub: w.sub,
      warn: w.warn,
      expect: w.expect,
      checks: w.checks,
      checkRuns: w.checkRuns,
      effort: w.effort,
      marker: w.marker,
      snapDir: w.snapDir,
      tokensCache: w.tokensCache,
      verify: w.verify,
      verifyTimeout: w.verifyTimeout,
      fixesLeft: w.fixesLeft,
      verifyResult: w.verifyResult,
      branch: w.branch,
      session: w.session,
      model: w.model,
      agent: w.agent,
      state: w.state,
      startedAt: w.startedAt,
      endedAt: w.endedAt,
      files: [...w.files],
      reads: [...w.reads].slice(0, 200),
      commands: w.commands.slice(-10),
      errors: w.errors.slice(-5),
      last: w.last,
      steps: w.steps,
      tokensIn: w.tokensIn,
      tokensOut: w.tokensOut,
      finalText: clip(w.texts.at(-1) ?? '', AGENTS[w.agent]?.report === 'detailed' ? REPORT_CHARS_FULL : 4000),
      summary: w.summary,
      outTokens: w.outTokens,
      genMs: w.genMs,
      spark: w.spark,
      maxMinutes: w.maxMinutes,
      cost: w.cost,
    })

    // Bring back what an earlier load knew, so a reload keeps ids and sessions (pi_send still works).
    const saved = (await $.store.get(storeKey).catch(() => undefined)) as
      | { at: number; workers: ReturnType<typeof record>[]; ledger?: { cost: number; tokens: number; spawned: number } }
      | undefined
    if (saved && Array.isArray(saved.workers)) {
      if (saved.ledger) await update($, ledgerAtom, () => saved.ledger!)
      for (const r of saved.workers) {
        const was = r.state === 'running'
        workers.set(r.id, {
          ...r,
          root: r.root ?? r.dir,
          agent: AGENTS[r.agent] ? r.agent : DEFAULT_AGENT,
          files: new Set(r.files),
          reads: new Set(r.reads ?? []),
          texts: r.finalText ? [r.finalText] : [],
          events: [],
          stderr: '',
          state: was ? 'killed' : r.state,
          last: was ? 'interrupted by a reload' : r.last,
          endedAt: r.endedAt ?? (was ? Date.now() : undefined),
          isReported: true,
          outTokens: r.outTokens ?? 0,
          genMs: r.genMs ?? 0,
          spark: r.spark ?? [],
          cost: r.cost ?? 0,
          warn: r.warn ?? [],
          tokensCache: r.tokensCache ?? 0,
          sawEnd: true,
          turnChars: 0,
          ratio: 0.28,
          win: [],
          toolArgs: {},
        })
        seq = Math.max(seq, Number(r.id.replace(/\D/g, '')) || 0)
      }
    }

    // Housekeeping: drop the old machine-wide key and the records of long-dead sessions.
    void (async () => {
      const keys = await $.store.keys().catch(() => [] as string[])
      for (const k of keys) {
        if (k === 'workers') {
          await $.store.delete(k).catch(() => undefined)
        } else if (k.startsWith(STORE_PREFIX) && k !== storeKey) {
          const other = (await $.store.get(k).catch(() => undefined)) as { at?: number } | undefined
          if (!other?.at || Date.now() - other.at > STALE_MS) await $.store.delete(k).catch(() => undefined)
        }
      }
    })()

    // Project dictionary: the supervisor's own glossary of the project, injected into every worker's system prompt.
    type Dict = Record<string, { def: string; at: number }>
    const loadDict = async (root: string): Promise<Dict> => {
      const d = (await $.store.get(DICT_PREFIX + root).catch(() => undefined)) as Dict | undefined
      return d && typeof d === 'object' ? d : {}
    }
    const dictBody = (d: Dict) =>
      Object.entries(d)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([term, v]) => `- ${term}: ${v.def}`)
        .join('\n')
    const dictText = async (root: string) => {
      const body = dictBody(await loadDict(root))
      return body
        ? `PROJECT DICTIONARY (kept by your supervisor: the project's terms, systems and where they live. Use it to skip re-learning the layout. It can be stale: if the code contradicts an entry, trust the code and say so in your report.)\n${body}`
        : ''
    }

    B = {
      summarize: async () => undefined,

      ledger: async (cost, tokens, spawned) => {
        await update($, ledgerAtom, l => ({
          cost: (l?.cost ?? 0) + cost,
          tokens: (l?.tokens ?? 0) + tokens,
          spawned: (l?.spawned ?? 0) + spawned,
        }))
      },

      sync: async () => {
        const all0 = [...workers.values()]
        const sig = all0.map(w => `${w.id}:${w.state}:${w.session ?? ''}:${w.files.size}:${w.steps}`).join(',')
        if (sig !== lastSig) {
          lastSig = sig
          await $.store
            .set(storeKey, { at: Date.now(), workers: all0.map(record), ledger: await read($, ledgerAtom) })
            .catch(() => undefined)
        }

      },

      // Coalesce streamed output into one state save per SYNC_MS.
      syncSoon: () => {
        if (syncTimer) return
        syncTimer = $.clock.after(SYNC_MS, () => {
          syncTimer = undefined
          void B?.sync()
        })
      },

      git: (args, dir) =>
        $.process.run(['git', ...args], { cwd: dir, timeoutMs: 30_000 }).catch(() => undefined),

      realPath: async dir => {
        const st = await $.fs.stat(dir, { resolve: true }).catch(() => undefined)
        return (st as { realPath?: string } | undefined)?.realPath
      },

      // A run is one prompt sent to the worker's Pi process. The process is started on the first prompt and
      // stays up, so a follow-up (pi_send) goes to a worker that still holds everything it learned.
      launch: (w, message) => {
        if (w.session) w.startedAt = Date.now()
        w.state = 'running'
        w.endedAt = undefined
        w.stderr = ''
        w.isReported = false
        w.sawEnd = false
        w.killed = false
        w.timedOut = false
        w.verifying = false
        w.verifyDone = false
        w.runError = undefined
        w.warn = []
        w.win = []
        w.live = ''
        w.act = 'think'
        w.last = w.steps > 0 ? `follow-up: ${clip(one(message), 60)}` : 'starting'
        void (async () => {
          const kind = AGENTS[w.agent] ?? AGENTS[DEFAULT_AGENT]!
          if (!w.send && !(await startProc(w))) return
          if (w.state !== 'running' || w.killed) { w.stop?.(); return }
          if (w.effort && w.effortSent !== w.effort) {
            w.effortSent = w.effort
            await w.send?.({ type: 'set_thinking_level', level: w.effort })
          }
          // Time limit: a wrap-up nudge at 85%, then at 100% a request for a partial report with a grace period,
          // and only then a hard stop. Nearly finished work is never killed silently.
          const mins = w.maxMinutes ?? 20
          w.timer?.cancel()
          w.soft?.cancel()
          w.grace?.cancel()
          w.soft = $.clock.after(mins * 60_000 * SOFT_FRACTION, () => {
            if (w.state !== 'running' || w.verifying) return
            const left = Math.max(1, Math.round(mins * (1 - SOFT_FRACTION)))
            void w.send?.({ type: 'steer', message: `Time check: about ${left} minute(s) of your time limit remain. Finish the core change now, then stop and report what is done and what is not.` })
          })
          w.timer = $.clock.after(mins * 60_000, () => {
            if (w.state !== 'running' || w.verifying) return
            w.timedOut = true
            void w.send?.({ type: 'steer', message: 'TIME LIMIT REACHED. Stop now and reply with your report: what is done and verified, what is not done, and the exact files you changed.' })
            w.grace = $.clock.after(GRACE_MS, () => {
              if (w.state !== 'running') return
              w.runError = `time limit (${mins}m) hit; no report within ${Math.round(GRACE_MS / 60_000)}m`
              w.errors.push(w.runError)
              w.stop?.()
            })
          })
          const body = message + kind.suffix
          await w.send?.({ type: 'prompt', message: body.startsWith('/') ? `Task: ${body}` : body })
        })().catch((err: Error) => { w.runError = err.message; w.errors.push(err.message); w.stop?.(); finish(w) })
      },

      changed: async w => {
        if (w.worktree) {
          const st = await B?.git(['status', '--porcelain', '--untracked-files=all'], workDir(w))
          if (!st || st.exitCode !== 0) return undefined
          return st.stdout.split('\n').filter(l => l.trim() && !/__pycache__|\.pyc$/.test(l)).map(l => l.slice(3).trim())
        }
        if (!w.marker) return undefined
        const prune = JUNK.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n]))
        const r = await $.process
          .run(['find', workDir(w), '(', ...prune, ')', '-prune', '-o', '-type', 'f', '-newer', w.marker, '-print'], { timeoutMs: 30_000 })
          .catch(() => undefined)
        if (!r) return undefined
        const base = `${workDir(w)}/`
        return r.stdout.split('\n').filter(Boolean).filter(f => !/__pycache__|\.pyc$|\.meta$/.test(f)).slice(0, 200).map(f => (f.startsWith(base) ? f.slice(base.length) : f))
      },

      // Review path for dirs with no worktree: the guard extension saved each file's original before the first
      // edit/write; this diffs them against now, and lists everything else that changed since the spawn.
      nonGitDiff: async (w, cap) => {
        const parts: string[] = []
        const seen = new Set<string>()
        const manifest = w.snapDir ? await $.fs.read(`${w.snapDir}/manifest.jsonl`).catch(() => undefined) : undefined
        for (const line of typeof manifest === 'string' ? manifest.split('\n').filter(Boolean) : []) {
          let m: { path: string; orig: string }
          try {
            m = JSON.parse(line)
          } catch {
            continue
          }
          if (m.path.startsWith(`${agentDir}/tmp/`)) continue // the worker's own scratch space, not part of the work
          const rel = m.path.startsWith(`${workDir(w)}/`) ? m.path.slice(workDir(w).length + 1) : m.path
          seen.add(rel)
          if (!m.orig) {
            parts.push(`--- new file: ${rel}`)
            continue
          }
          const d = await $.process.run(['diff', '-u', '--label', `a/${rel}`, '--label', `b/${rel}`, m.orig, m.path], { timeoutMs: 20_000 }).catch(() => undefined)
          if (d && d.stdout.trim()) parts.push(d.stdout.trimEnd())
        }
        const others = ((await B?.changed(w)) ?? []).filter(f => !seen.has(f))
        const head = `${seen.size} file(s) edited with edit/write (new files are listed, existing ones diffed against the original)${others.length ? `; ${others.length} more changed by other means (shell), no baseline: ${others.slice(0, 20).join(', ')}${others.length > 20 ? ', …' : ''}` : ''}`
        return clip([head, ...parts].join('\n\n'), cap)
      },

      verify: async w => {
        const run = verifyChain.then(async () => {
          if (w.state !== 'running' || !w.verify) return undefined
          w.last = `verifying: ${clip(one(w.verify), 60)}`
          return $.process.run(['bash', '-c', w.verify], { cwd: workDir(w), timeoutMs: Math.min(600, w.verifyTimeout ?? 300) * 1000 }).catch(() => null)
        })
        verifyChain = run.then(() => undefined, () => undefined)
        const r = await run
        w.verifying = false
        if (w.state !== 'running') return
        const ok = r?.exitCode === 0
        const tail = r ? clip(`${r.stdout}\n${r.stderr}`.trim().slice(-VERIFY_TAIL * 2), VERIFY_TAIL).replace(/^…/, '…') : 'the verify command timed out or could not start'
        w.verifyResult = { ok, exit: r?.exitCode ?? -1, tail }
        if (!ok && (w.fixesLeft ?? 0) > 0) {
          w.fixesLeft = (w.fixesLeft ?? 0) - 1
          B?.launch(w, `The supervisor ran the verification (${w.verify}) after your work and it FAILED (exit ${r?.exitCode ?? 'n/a'}). Output tail:\n${tail}\n\nFix the cause in the code. Do not weaken or bypass the check. Then stop and report.`)
          return
        }
        w.verifyDone = true
        if (!ok) w.warn.push(`verify FAILED (exit ${r?.exitCode ?? 'n/a'}): ${clip(one(tail), 160)}`)
        finish(w)
      },

      finished: async w => {
        const kind = AGENTS[w.agent] ?? AGENTS[DEFAULT_AGENT]!
        if (w.state !== 'killed' && (!kind.tools || kind.tools.includes('edit'))) {
          const changed = await B?.changed(w)
          if (changed) {
            if (w.state === 'done' && changed.length === 0) w.warn.push('NO FILES CHANGED: the worker finished without modifying anything')
            for (const x of w.expect ?? []) {
              if (!changed.some(c => c === x || c.endsWith(`/${x}`))) w.warn.push(`expected change missing: ${x}`)
            }
          }
        }
        // What the worker's `check` runs recorded (bin/check appends one line per run to $TMPDIR/checks.jsonl).
        const log = await $.fs.read(`${tmpDir(w)}/checks.jsonl`).catch(() => undefined)
        w.checkRuns = (typeof log === 'string' ? log.split('\n') : [])
          .flatMap(l => {
            try {
              const r = JSON.parse(l)
              return r && typeof r.name === 'string' && r.at >= w.startedAt ? [{ name: r.name, ok: !!r.ok, exit: Number(r.exit), secs: Number(r.secs) }] : []
            } catch {
              return []
            }
          })
          .slice(-12)
        if (w.state !== 'killed') {
          for (const n of w.checks ?? []) {
            const last = w.checkRuns.filter(r => r.name === n).at(-1)
            if (!last) w.warn.push(`required check not run: ${n}`)
            else if (!last.ok) w.warn.push(`check FAILED: ${n} (exit ${last.exit})`)
          }
        }
        await sync()
      },
    }

    const tmpDir = (w: Worker) => `${agentDir}/tmp/${sid}-${w.id}`
    const childEnv = (w: Worker): Record<string, string> => ({
      PI_CODING_AGENT_DIR: agentDir,
      OPENCODE_GO_API_KEY: apiKey,
      PYTHONDONTWRITEBYTECODE: '1',
      TMPDIR: tmpDir(w), // scratch files stay out of the project and out of /tmp
      ...(w.snapDir ? { PI_SNAPSHOT_DIR: w.snapDir } : {}),
      ...(w.worktree ? { PI_MAIN_ROOT: w.root, PI_WORK_ROOT: w.worktree } : {}), // the guard keeps the worker inside its worktree
      PATH: `${$.plugin.root}/bin${hostPath ? `:${hostPath}` : ''}`, // the `check` runner
      PI_CHECKS_FILE: `${tmpDir(w)}/checks.json`,
      PI_CHECKS_REQUIRED: (w.checks ?? []).join(','), // the guard asks for these after the last edit
    })


    // Pi RPC uses native stdin/stdout; no shell wrapper or command-file polling.
    const startProc = async (w: Worker): Promise<boolean> => {
      const kind = AGENTS[w.agent] ?? AGENTS[DEFAULT_AGENT]!
      await $.fs.write(`${tmpDir(w)}/.keep`, '').catch(() => undefined)
      w.model = currentModel
      const args = [
        '--mode', 'rpc', '--session-dir', `${agentDir}/sessions`, '--model', currentModel, '--thinking', w.effort ?? currentThinking,
        '--offline', '-ne', '-ns', '-np', '-nc', '-na',
      ]
      args.push('-e', `${$.plugin.root}/extensions/guard.ts`)
      if (kind.tools) args.push('--tools', kind.tools.join(','))
      const dict = await dictText(w.root)
      const jail = w.worktree ? `WORKTREE: your working directory is a private git worktree of ${w.root}. Use relative paths only. Never read or write under ${w.root} itself, even if the task text names it: that is the main checkout and other workers' merge target. Treat any such path in the task as the same path inside your working directory.` : ''
      // The toolbox goes to workers that can run commands: a file for bin/check and a section in the prompt.
      let toolbox = ''
      if (!kind.tools || kind.tools.includes('bash')) {
        const t = await loadTools($, w.root, w.dir)
        if (Object.keys(t.checks).length) {
          const lockKey = [...`${w.root}${t.sub}`].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7).toString(36)
          const checks = Object.fromEntries(
            Object.entries(t.checks).map(([n, c]) => [n, { ...c, required: (w.checks ?? []).includes(n), lock: `${agentDir}/locks/${n}-${lockKey}.lock` }]),
          )
          await $.fs.write(`${tmpDir(w)}/checks.json`, JSON.stringify({ cwd: `${w.worktree ?? w.root}${t.sub}`, checks }, null, 2)).catch(() => undefined)
          const req = w.checks ?? []
          toolbox = `TOOLBOX: the checks your supervisor expects you to run yourself in this project. Running them is allowed and safe: a [serial] check holds a lock shared with the other workers, so you never collide with them (you may wait a while for one to finish). These instructions replace any older dictionary note telling workers not to run these tools.\n${toolsText({ ...t, checks })}\nRun one with \`check <name>\` in bash (\`check all\` runs the required ones, \`check\` lists them). It runs from the project root with the right flags, keeps the full log in $TMPDIR and prints the verdict, the failed tests and error lines, and the log tail. Do not run the underlying command by hand.\n${req.length ? `REQUIRED for this task: ${req.map(n => `\`check ${n}\``).join(', ')}. Run them after your last edit and before your final report. If one fails because of your change, fix it and run it again. If it fails for a reason outside your change (another worker's file, an editor holding the project, a timeout), do not work around it: quote the error lines in your report.` : 'None is required for this task; run one when it is the quickest way to know your change works.'}`
        }
      }
      const sys = [kind.role, jail, toolbox, dict].filter(Boolean).join('\n\n')
      if (sys) args.push('--append-system-prompt', sys)
      if (w.session) args.push('--session', w.session)
      w.effortSent = w.effort ?? currentThinking
      const proc = $.process.spawn({ argv: ['pi', ...args], cwd: workDir(w), env: childEnv(w) })
      const it = proc[Symbol.asyncIterator]()
      let stopped = false
      w.send = async cmd => { await proc.write(JSON.stringify(cmd) + '\n') }
      w.stop = () => {
        stopped = true
        w.send = undefined
        w.stop = undefined
        void it.return?.(undefined as never)
        if (w.state === 'running') {
          if (!w.runError) w.killed = true
          finish(w)
        }
      }
      void (async () => {
        let buf = ''
        let code: number | null = null
        try {
          for (;;) {
            const step = await it.next()
            if (step.done) {
              code = step.value?.code ?? null
              break
            }
            const { stream: pipe, text: chunk } = step.value
            if (pipe === 'stderr') {
              w.stderr = (w.stderr + chunk).slice(-2000)
              continue
            }
            buf += chunk
            let nl = buf.indexOf('\n')
            while (nl >= 0) {
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (line) ingest(w, line)
              nl = buf.indexOf('\n')
            }
            B?.syncSoon()
          }
          if (buf.trim()) ingest(w, buf.trim())
        } catch (err) {
          w.errors.push(`spawn: ${String((err as Error)?.message ?? err)}`)
        }
        // The process ended on its own (crash, bad flag, auth failure): a run in flight failed with it.
        if (!stopped) {
          w.send = undefined
          w.stop = undefined
          if (w.state === 'running') {
            w.runError ??= `pi exited${code != null ? ` ${code}` : ''} before the run finished${w.stderr.trim() ? `: ${clip(one(w.stderr), 160)}` : ''}`
            w.errors.push(w.runError)
            finish(w)
          }
        }
      })()
      await w.send({ type: 'get_state' })
      return true
    }

    const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
      type: 'object',
      properties,
      required,
    })
    const idProp = { id: { type: 'string', description: 'Worker id from pi_spawn' } }

    await $.tool.register({
      name: 'pi_spawn',
      description:
        'Start a Pi worker in the background on a self-contained task and return its id at once. Workers always use the model the user set with pi_model (not selectable here). Give it a complete standalone brief (it has no access to this conversation). Use disjoint dirs or let worktree isolation separate parallel workers. Then use pi_wait / pi_digest to read compact results and judge them. Workers are long-lived RPC processes that keep their context: for a fix or a follow-up in the same area, pi_send an existing worker instead of spawning a new one.',
      inputSchema: obj(
        {
          task: { type: 'string', description: 'Complete standalone instructions for the worker' },
          dir: { type: 'string', description: 'Working directory (default: session cwd)' },
          title: { type: 'string', description: 'Short label' },
          agent: {
            type: 'string',
            enum: Object.keys(AGENTS),
            description: `Agent type (default ${DEFAULT_AGENT}). ${Object.entries(AGENTS).map(([k, a]) => `${k}: ${a.about}`).join('; ')}`,
          },
          maxMinutes: { type: 'number', description: 'time limit for the run (default depends on agent type, 15-20). At 85% the worker is told to wrap up; at 100% it is asked for a partial report and gets 2 more minutes before it is stopped. pi_send can resume it.' },
          checks: { type: 'array', items: { type: 'string' }, description: 'Toolbox checks (pi_tools) the worker must run and pass after its last edit. Default: the toolbox entries marked required. [] = none for this task. The worker runs them itself with `check <name>`; serial ones never run twice at once.' },
          verify: { type: 'string', description: 'A shell command the PLUGIN runs itself in the worker\'s directory after the worker finishes (one at a time across workers, up to 10 min). Prefer toolbox checks (pi_tools), which the worker runs and fixes itself; use verify for a final gate the worker must not run. The result goes in the digest; a failure counts as a warning.' },
          verifyTimeoutSec: { type: 'number', description: 'Time limit for the verify command (default 300, max 600).' },
          fixRounds: { type: 'number', description: 'With verify: how many times (0-3, default 0) a failing verify is sent back to the worker to fix automatically.' },
          expect: { type: 'array', items: { type: 'string' }, description: 'Paths (relative to dir) the task must change. If the worker finishes without changing one, the digest, status and wake-up message carry a warning.' },
          effort: { type: 'string', enum: THINKING_LEVELS, description: 'Reasoning effort for this worker only (default: the pi_effort setting). Raise it for tasks that need real reasoning.' },
          noDict: { type: 'boolean', description: 'Skip the project-dictionary requirement for a dev/general worker (the first one in a project is refused until pi_dict has entries).' },
          worktree: {
            type: 'boolean',
            description: 'Isolate in a new git worktree (default depends on agent type; dev and general: true when dir is a git repo, explore and review: false)',
          },
        },
        ['task'],
      ),
    })
    await $.tool.register({
      name: 'pi_dict',
      description:
        'The project dictionary: short term -> definition entries (what a system is called, what it does, where it lives, conventions) that are injected into every worker for that project. Seed it from what you already understand BEFORE the first pi_spawn; after reviewing a worker, add facts you verified (never unverified worker claims). Not for task notes or history. action: show | set (upsert entries) | remove (terms).',
      inputSchema: obj(
        {
          action: { type: 'string', enum: ['show', 'set', 'remove'] },
          dir: { type: 'string', description: 'Any directory inside the project (default: session cwd)' },
          entries: {
            type: 'array',
            description: `For set: [{term, definition}]. Definitions are one or two sentences (max ${DICT_DEF_CHARS} chars); name file paths.`,
            items: obj({ term: { type: 'string' }, definition: { type: 'string' } }, ['term', 'definition']),
          },
          terms: { type: 'array', items: { type: 'string' }, description: 'For remove' },
        },
        ['action'],
      ),
    })
    await $.tool.register({
      name: 'pi_tools',
      description:
        'The project toolbox: the checks (tests, compile, lint) workers are expected to run THEMSELVES with `check <name>` before reporting. Shown in every dev/general worker\'s prompt; required checks are enforced (the worker is reminded, and the digest warns if one was not run or failed). serial checks hold a project-wide lock, so a tool that cannot run twice at once (a Unity editor, a Gradle daemon) is safe with parallel workers: do not forbid workers from running it. A Unity project with no toolbox set gets built-in unity-editmode (required) and unity-playmode checks. action: show | set (upsert checks) | remove (names) | reset (drop all, back to the built-in default).',
      inputSchema: obj(
        {
          action: { type: 'string', enum: ['show', 'set', 'remove', 'reset'] },
          dir: { type: 'string', description: 'Any directory inside the project (default: session cwd)' },
          checks: {
            type: 'array',
            description: 'For set: checks to add or replace. The first set on a project starts from the built-in default if there is one.',
            items: obj(
              {
                name: { type: 'string', description: 'Short id, e.g. editmode, unit, lint' },
                command: { type: 'string', description: 'bash command, run from the project root (the worker\'s worktree root when it has one). $TMPDIR is the worker\'s scratch dir.' },
                purpose: { type: 'string', description: 'One line: what it checks and when to run it' },
                required: { type: 'boolean', description: 'Default true: every dev/general worker must run it after its last edit' },
                serial: { type: 'boolean', description: 'Default false: true = one run at a time across all workers of this project (locks the project, heavy)' },
                timeoutSec: { type: 'number', description: 'Default 600' },
                report: { type: 'string', description: 'NUnit/JUnit XML path the command writes; failed tests are listed from it' },
                log: { type: 'string', description: 'Extra log file the command writes, searched for error lines on failure' },
                highlight: { type: 'string', description: 'Regex for the error lines to show on failure' },
                retryIf: { type: 'string', description: 'Regex: when a failed run\'s output matches, wait 15 s and retry within the timeout (a tool another process holds briefly). If group 1 captures a PID, retry only while that process is a -batchmode run' },
              },
              ['name', 'command', 'purpose'],
            ),
          },
          names: { type: 'array', items: { type: 'string' }, description: 'For remove' },
        },
        ['action'],
      ),
    })
    await $.tool.register({
      name: 'pi_status',
      description: 'One line per worker: state, elapsed, last action, files touched.',
      inputSchema: obj({}),
    })
    await $.tool.register({
      name: 'pi_digest',
      description:
        'Compact report of one worker: files changed, commands, errors, final message, git status. detail "full" adds recent raw events. Treat claims as unverified; check with pi_diff.',
      inputSchema: obj(
        { ...idProp, detail: { type: 'string', enum: ['brief', 'full'] } },
        ['id'],
      ),
    })
    await $.tool.register({
      name: 'pi_wait',
      description:
        'Wait until the given workers (default: all running) finish or timeoutSec passes (max 60 per call; call again to keep waiting), then return their digests.',
      inputSchema: obj({
        ids: { type: 'array', items: { type: 'string' } },
        timeoutSec: { type: 'number' },
        mode: { type: 'string', enum: ['all', 'any'], description: 'default all' },
      }),
    })
    await $.tool.register({
      name: 'pi_send',
      description:
        'Send a follow-up message to a finished worker. Its Pi process (or, after 30 idle minutes, its saved session) keeps everything it already read, so use this for fixes and for the next task in the same area instead of re-spawning (no re-reading, no re-learning the layout). Send only the new instruction; it already has the background. The worker must not be running.',
      inputSchema: obj(
        {
          ...idProp,
          message: { type: 'string' },
          maxMinutes: { type: 'number', description: 'New time limit for this run (use it to give a worker that hit its limit more time).' },
          effort: { type: 'string', enum: THINKING_LEVELS, description: 'Change this worker\'s reasoning effort from this message on.' },
        },
        ['id', 'message'],
      ),
    })
    await $.tool.register({
      name: 'pi_diff',
      description: 'git diff (with stat) of a worker\'s directory so you can review the real changes.',
      inputSchema: obj({ ...idProp, maxChars: { type: 'number' } }, ['id']),
    })
    await $.tool.register({
      name: 'pi_kill',
      description: 'Abort a running worker and stop its Pi process.',
      inputSchema: obj(idProp, ['id']),
    })

    await $.tool.register({
      name: 'pi_merge',
      description:
        "Commit a finished worker's worktree changes and merge its branch (--no-ff) into the repo it was spawned from. Refuses while the worker runs or the main tree has tracked changes; aborts and reports on conflict.",
      inputSchema: obj({ ...idProp, message: { type: 'string', description: 'Merge commit message' } }, ['id']),
    })
    await $.tool.register({
      name: 'pi_cleanup',
      description:
        "Remove a finished worker's worktree and branch and forget the worker. Refuses if it has unmerged work unless force is true.",
      inputSchema: obj({ ...idProp, force: { type: 'boolean' } }, ['id']),
    })

    await $.command.register({ name: 'pi-model', description: 'Show or change the model every Pi worker uses' })
    await $.command.register({ name: 'pi-effort', description: 'Show or change the reasoning effort every Pi worker uses' })

    $.clock.every(1000, () => {
      if (running() > 0) void sync()
      // An idle worker's process is stopped after a while; pi_send resumes its saved session.
      for (const w of workers.values()) {
        if (w.stop && w.state !== 'running' && w.endedAt && Date.now() - w.endedAt > IDLE_STOP_MS) w.stop()
      }
    })
    return next(e)
  })

  on('session.end', async (_$, e, next) => {
    for (const w of workers.values()) w.stop?.()
    await sync()
    return next(e)
  })

  on('command.run', { command: 'pi-model' }, async ($, e) => {
    const arg = String((e as { args?: string }).args ?? '').trim()
    const set = async (m: string) => {
      currentModel = m
      await $.store.set('model', m).catch(() => undefined)
    }
    const status = `worker model: ${currentModel}${currentModel === DEFAULT_MODEL ? ' (plugin default)' : ` (plugin default is ${DEFAULT_MODEL})`}`
    if (!arg) {
      return { text: `${status}\nChange it: pi_model <provider/model or part of a name>. Reset: pi_model reset. List: pi --list-models. Models other than the bundled one must exist in ${agentDir}/models.json or Pi's catalog.` }
    }
    if (arg === 'reset' || arg === 'default') {
      await set(DEFAULT_MODEL)
      return { text: `worker model reset to ${DEFAULT_MODEL}. Applies to workers started or resumed from now on.` }
    }
    const notReady = await ensureSetup()
    if (notReady) return { text: notReady }
    const query = arg.includes('/') ? arg.split('/').slice(1).join('/') : arg
    // `pi --list-models <query>` prints a table: provider, model, context, ...
    const listed = await $.process
      .run(['pi', '--list-models', query], { env: { PI_CODING_AGENT_DIR: agentDir, OPENCODE_GO_API_KEY: apiKey }, timeoutMs: 30_000 })
      .catch(() => undefined)
    const models =
      listed && listed.exitCode === 0
        ? listed.stdout
            .split('\n')
            .map(l => l.trim().split(/\s+/))
            .filter(c => c.length >= 2 && c[0] !== 'provider')
            .map(c => ({ selector: `${c[0]}/${c[1]}`, context: c[2] }))
        : undefined
    if (!models) return { text: `could not read the model list from pi. ${status}` }
    const exact = models.filter(m => m.selector === arg)
    const hits = exact.length ? exact : models.filter(m => m.selector.includes(arg) || !arg.includes('/'))
    if (!hits.length) return { text: `no pi model matches "${arg}". ${status}` }
    if (hits.length > 1) {
      const list = hits.slice(0, 10).map(m => `  ${m.selector}`).join('\n')
      return { text: `${hits.length} models match "${arg}"; pass the exact selector:\n${list}${hits.length > 10 ? '\n  …' : ''}\n${status}` }
    }
    const m = hits[0]!
    await set(m.selector)
    return { text: `worker model set to ${m.selector}${m.context ? ` (${m.context} context)` : ''}. Applies to workers started or resumed from now on; running workers keep theirs. Resumed workers whose process was stopped start a new one with this model.` }
  })

  on('command.run', { command: 'pi-effort' }, async ($, e) => {
    const arg = String((e as { args?: string }).args ?? '').trim().toLowerCase()
    const status = `worker effort: ${currentThinking}${currentThinking === DEFAULT_THINKING ? ' (plugin default)' : ` (plugin default is ${DEFAULT_THINKING})`}`
    if (!arg) {
      return { text: `${status}\nChange it: pi_effort <${THINKING_LEVELS.join('|')}>. Reset: pi_effort reset.` }
    }
    const level = arg === 'reset' || arg === 'default' ? DEFAULT_THINKING : arg
    if (!THINKING_LEVELS.includes(level)) {
      return { text: `unknown effort "${arg}". Levels: ${THINKING_LEVELS.join(', ')}. ${status}` }
    }
    currentThinking = level
    await $.store.set('thinking', level).catch(() => undefined)
    return { text: `worker effort set to ${level}. Applies to workers started from now on (a live worker process keeps the level it started with); Pi clamps it to what the model supports.` }
  })

  on('tool.call', { tool: 'mcp__omp-conductor__pi_spawn' }, async ($, e) => {
    const notReady = await ensureSetup()
    if (notReady) return text(notReady, true)
    const task = String(e.task ?? '').trim()
    if (!task) return text('task is required', true)
    if (running() >= MAX_WORKERS) {
      return text(`max ${MAX_WORKERS} concurrent workers; wait for one to finish first`, true)
    }
    const agent = String(e.agent ?? DEFAULT_AGENT)
    const kind = AGENTS[agent]
    if (!kind) return text(`unknown agent "${agent}"; choose one of: ${Object.keys(AGENTS).join(', ')}`, true)
    if (e.effort !== undefined && !THINKING_LEVELS.includes(String(e.effort))) return text(`effort must be one of ${THINKING_LEVELS.join(', ')}`, true)
    const dir = (await B?.realPath(String(e.dir ?? cwd))) ?? String(e.dir ?? cwd)
    if (!(await B?.realPath(dir))) return text(`dir ${dir} does not exist`, true)
    if (!(await insideRoots(dir))) {
      return text(`dir ${dir} is outside the allowed roots (${roots().filter(Boolean).join(', ')}) or is a protected dir`, true)
    }
    seq += 1
    const id = `w${seq}`
    const top = await $.process
      .run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 10_000 })
      .catch(() => undefined)
    const isGit = top?.exitCode === 0
    // Without a dictionary every dev worker re-discovers the same layout (and the same traps). Make the supervisor seed one.
    if (kind.tools?.includes('edit') !== false && e.noDict !== true) {
      const have = Object.keys(((await $.store.get(DICT_PREFIX + (isGit ? top!.stdout.trim() : dir)).catch(() => undefined)) as object | undefined) ?? {}).length
      if (!have) {
        seq -= 1
        return text(`No project dictionary for ${isGit ? top!.stdout.trim() : dir} yet. Workers re-learn the layout every time without one. Seed it first with pi_dict (set): the main folders and what lives where, conventions, what workers must not touch. Put the checks workers should run themselves (tests, compile) in pi_tools, not the dictionary. Then spawn again. (Pass noDict:true to skip, e.g. for a throwaway task.)`, true)
      }
    }
    const projRoot = isGit ? top!.stdout.trim() : dir
    const tools = await loadTools($, projRoot, dir)
    let checks: string[] = []
    if (!kind.tools || kind.tools.includes('bash')) {
      if (Array.isArray(e.checks)) {
        checks = (e.checks as unknown[]).map(String)
        const unknown = checks.filter(n => !tools.checks[n])
        if (unknown.length) {
          seq -= 1
          return text(`unknown check(s) ${unknown.join(', ')}; the toolbox for ${projRoot} has: ${Object.keys(tools.checks).join(', ') || 'nothing (add some with pi_tools set)'}`, true)
        }
      } else checks = Object.entries(tools.checks).filter(([, c]) => c.required).map(([n]) => n)
    }
    let worktree: string | undefined
    let branch: string | undefined
    let sub: string | undefined
    const wantTree = e.worktree === undefined ? kind.worktree === 'auto' && isGit : e.worktree === true
    if (wantTree) {
      if (!isGit) return text('worktree requested but dir is not a git repo', true)
      const root = top!.stdout.trim()
      const parent = root.slice(0, root.lastIndexOf('/')) || '/'
      const name = root.slice(root.lastIndexOf('/') + 1)
      const tag = Date.now().toString(36)
      const path = `${parent}/.omp-worktrees/${name}-${id}-${tag}`
      const made = await $.process.run(['git', 'worktree', 'add', '-b', `omp/${name}-${id}-${tag}`, path], {
        cwd: root,
        timeoutMs: 60_000,
      })
      if (made.exitCode !== 0) return text(`git worktree failed: ${made.stderr.trim()}`, true)
      worktree = path
      branch = `omp/${name}-${id}-${tag}`
      // dir may be inside the repo: start the worker at the same place in its worktree (if it is tracked there).
      const real = (await B?.realPath(dir)) ?? dir
      const inside = real.startsWith(`${root}/`) ? real.slice(root.length) : ''
      if (inside && (await $.fs.exists(`${path}${inside}`).catch(() => false))) sub = inside
      // A Unity project's Library (the import cache) is not in git, and without it a worktree's first Unity run
      // re-imports everything. Copy-on-write clone it (btrfs/xfs: instant, no extra space); skipped elsewhere.
      const lib = `${root}${tools.sub}/Library`
      if ((await $.fs.exists(`${root}${tools.sub}/ProjectSettings/ProjectVersion.txt`).catch(() => false)) && (await $.fs.exists(lib).catch(() => false))) {
        await $.process.run(['cp', '-a', '--reflink=always', lib, `${path}${tools.sub}/Library`], { timeoutMs: 120_000 }).catch(() => undefined)
        // The clone must not claim the editor that has the main project open.
        await $.process.run(['rm', '-f', `${path}${tools.sub}/Library/EditorInstance.json`], { timeoutMs: 10_000 }).catch(() => undefined)
      }
    }
    const w: Worker = {
      id,
      title: String(e.title ?? clip(one(task), 40)),
      task,
      dir,
      root: isGit ? top!.stdout.trim() : dir,
      isGit,
      worktree,
      sub,
      branch,
      model: currentModel,
      agent,
      state: 'running',
      startedAt: Date.now(),
      files: new Set(),
      reads: new Set(),
      commands: [],
      errors: [],
      texts: [],
      events: [],
      last: 'starting',
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
      stderr: '',
      isReported: false,
      outTokens: 0,
      genMs: 0,
      spark: [],
      maxMinutes: typeof e.maxMinutes === 'number' && e.maxMinutes > 0 ? Math.min(e.maxMinutes, 240) : kind.maxMinutes,
      verify: typeof e.verify === 'string' && e.verify.trim() ? e.verify.trim() : undefined,
      verifyTimeout: typeof e.verifyTimeoutSec === 'number' ? e.verifyTimeoutSec : undefined,
      fixesLeft: typeof e.fixRounds === 'number' ? Math.min(3, Math.max(0, Math.floor(e.fixRounds))) : 0,
      expect: Array.isArray(e.expect) ? (e.expect as unknown[]).map(String).filter(Boolean) : undefined,
      checks: checks.length ? checks : undefined,
      effort: e.effort === undefined ? undefined : String(e.effort),
      cost: 0,
      warn: [],
      tokensCache: 0,
      sawEnd: false,
      turnChars: 0,
      ratio: 0.28,
      win: [],
      toolArgs: {},
    }
    // No worktree: remember when it started (to list what changed) and where the guard saves file originals (for pi_diff).
    if (!w.worktree) {
      w.marker = `${agentDir}/run/${sid}-${w.id}.marker`
      w.snapDir = `${agentDir}/snap/${sid}-${w.id}`
      await $.fs.write(w.marker, '').catch(() => undefined)
      await $.fs.write(`${w.snapDir}/manifest.jsonl`, '').catch(() => undefined)
    }
    workers.set(id, w)
    void B?.ledger(0, 0, 1)
    B?.launch(w, task)
    await sync()
    const seeded = Object.keys(((await $.store.get(DICT_PREFIX + w.root).catch(() => undefined)) as object | undefined) ?? {}).length > 0
    return text(
      `started ${id} [${agent}] "${w.title}" in ${workDir(w)}` +
        (checks.length ? `\nrequired checks (the worker runs them itself): ${checks.join(', ')}${tools.source === 'unity default' ? ' (built-in Unity toolbox)' : ''}` : '') +
        (seeded ? '' : `\nNo project dictionary for ${w.root} yet. Seed one with pi_dict (set) before the next spawn so workers stop re-learning the project.`),
    )
  })

  on('tool.call', { tool: 'mcp__omp-conductor__pi_dict' }, async ($, e) => {
    const action = String(e.action ?? '')
    const dir = (await B?.realPath(String(e.dir ?? cwd))) ?? String(e.dir ?? cwd)
    if (!(await B?.realPath(dir))) return text(`dir ${dir} does not exist`, true)
    if (!(await insideRoots(dir))) return text(`dir ${dir} is outside the allowed roots or is a protected dir`, true)
    const top = await $.process
      .run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 10_000 })
      .catch(() => undefined)
    const root = top?.exitCode === 0 ? top.stdout.trim() : dir
    const key = DICT_PREFIX + root
    const dict = ((await $.store.get(key).catch(() => undefined)) as Record<string, { def: string; at: number }> | undefined) ?? {}
    const render = () => {
      const body = Object.entries(dict)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([term, v]) => `- ${term}: ${v.def}`)
        .join('\n')
      return `${root}: ${Object.keys(dict).length} entries, ${body.length}/${DICT_MAX_CHARS} chars${body ? `\n${body}` : ''}`
    }
    if (action === 'show') return text(render())
    if (action === 'set') {
      const entries = Array.isArray(e.entries) ? (e.entries as { term?: unknown; definition?: unknown }[]) : []
      if (!entries.length) return text('entries is required for set', true)
      const next = { ...dict }
      for (const it of entries) {
        const term = one(String(it.term ?? ''))
        const def = one(String(it.definition ?? ''))
        if (!term || !def) return text('every entry needs a term and a definition', true)
        if (def.length > DICT_DEF_CHARS) return text(`definition of "${term}" is ${def.length} chars; keep it under ${DICT_DEF_CHARS} (point at a file instead of explaining it)`, true)
        next[term] = { def, at: Date.now() }
      }
      const size = Object.entries(next).reduce((n, [t, v]) => n + t.length + v.def.length + 4, 0)
      if (size > DICT_MAX_CHARS) return text(`dictionary would be ${size} chars (max ${DICT_MAX_CHARS}); remove or tighten entries first`, true)
      await $.store.set(key, next).catch(() => undefined)
      Object.assign(dict, next)
      return text(`saved ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}. ${render().split('\n')[0]}`)
    }
    if (action === 'remove') {
      const terms = Array.isArray(e.terms) ? (e.terms as unknown[]).map(t => one(String(t))) : []
      if (!terms.length) return text('terms is required for remove', true)
      const gone = terms.filter(t => t in dict)
      for (const t of gone) delete dict[t]
      await $.store.set(key, dict).catch(() => undefined)
      return text(`removed ${gone.length}/${terms.length}. ${render().split('\n')[0]}`)
    }
    return text('action must be show, set or remove', true)
  })

  on('tool.call', { tool: 'mcp__omp-conductor__pi_tools' }, async ($, e) => {
    const action = String(e.action ?? '')
    const dir = (await B?.realPath(String(e.dir ?? cwd))) ?? String(e.dir ?? cwd)
    if (!(await B?.realPath(dir))) return text(`dir ${dir} does not exist`, true)
    if (!(await insideRoots(dir))) return text(`dir ${dir} is outside the allowed roots or is a protected dir`, true)
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 10_000 }).catch(() => undefined)
    const root = top?.exitCode === 0 ? top.stdout.trim() : dir
    const key = TOOLS_PREFIX + root
    const t = await loadTools($, root, dir)
    const render = (x: Toolbox) =>
      `${root}: ${Object.keys(x.checks).length} check(s)${x.source === 'unity default' ? ' (built-in Unity default; pi_tools set to customize)' : ''}${Object.keys(x.checks).length ? `\n${toolsText(x)}` : '\nnone: workers only run the checks a brief names'}`
    if (action === 'show') return text(render(t))
    if (action === 'reset') {
      await $.store.delete(key).catch(() => undefined)
      return text(`toolbox reset. ${render(await loadTools($, root, dir))}`)
    }
    if (action === 'set') {
      const list = Array.isArray(e.checks) ? (e.checks as Record<string, unknown>[]) : []
      if (!list.length) return text('checks is required for set', true)
      const next: Record<string, Check> = { ...t.checks }
      for (const c of list) {
        const name = String(c.name ?? '').trim()
        if (!CHECK_NAME.test(name)) return text(`bad check name "${name}": lowercase letters, digits, . _ - (max 40)`, true)
        const command = String(c.command ?? '').trim()
        const purpose = one(String(c.purpose ?? ''))
        if (!command || !purpose) return text(`check "${name}" needs a command and a purpose`, true)
        next[name] = {
          command,
          purpose: clip(purpose, 240),
          required: c.required !== false,
          serial: c.serial === true,
          timeoutSec: typeof c.timeoutSec === 'number' && c.timeoutSec > 0 ? Math.min(c.timeoutSec, 3600) : 600,
          ...(typeof c.report === 'string' && c.report ? { report: c.report } : {}),
          ...(typeof c.log === 'string' && c.log ? { log: c.log } : {}),
          ...(typeof c.highlight === 'string' && c.highlight ? { highlight: c.highlight } : {}),
          ...(typeof c.retryIf === 'string' && c.retryIf ? { retryIf: c.retryIf } : {}),
        }
        try {
          for (const re of [next[name]!.highlight, next[name]!.retryIf]) if (re) new RegExp(re)
        } catch {
          return text(`check "${name}": highlight or retryIf is not a valid regex`, true)
        }
      }
      await $.store.set(key, next).catch(() => undefined)
      return text(`saved ${list.length} check(s); applies to workers started from now on. ${render({ ...t, checks: next, source: 'set' })}`)
    }
    if (action === 'remove') {
      const names = Array.isArray(e.names) ? (e.names as unknown[]).map(String) : []
      if (!names.length) return text('names is required for remove', true)
      const next = { ...t.checks }
      const gone = names.filter(n => n in next)
      for (const n of gone) delete next[n]
      await $.store.set(key, next).catch(() => undefined)
      return text(`removed ${gone.length}/${names.length}. ${render({ ...t, checks: next, source: 'set' })}`)
    }
    return text('action must be show, set, remove or reset', true)
  })

  on('tool.call', { tool: 'mcp__omp-conductor__pi_status' }, async $ => {
    const led = await read($, ledgerAtom)
    if (!workers.size) return text(`no workers · session ${money(led.cost)}`)
    return text(
      [...workers.values()]
        .map(w => {
          const r = (w.state === 'running' ? liveTps(w, Date.now()) : undefined) ?? w.tps
          return `[${w.id}] ${w.state} ${elapsed(w)} files=${w.files.size}${r ? ` ⚡${Math.round(r)}tok/s` : ''} ${money(w.cost)}${w.warn.length ? ` ⚠${w.warn.length}` : ''} — ${w.title} — ${w.last}`
        })
        .concat(`session total ${money(led.cost)} · ${led.spawned} spawned`)
        .join('\n'),
    )
  })

  on('tool.call', { tool: 'mcp__omp-conductor__pi_digest' }, async (_$, e) => {
    const w = pick(e)
    if (!w) return text(`no worker ${String(e.id)}`, true)
    if (w.state !== 'running') w.isReported = true
    return text(await digest(w, e.detail === 'full'))
  })

  on('tool.call', { tool: 'mcp__omp-conductor__pi_wait' }, async ($, e, next) => {
    const ids = Array.isArray(e.ids) && e.ids.length
      ? (e.ids as string[])
      : [...workers.values()].filter(w => w.state === 'running').map(w => w.id)
    const list = ids.map(i => workers.get(i)).filter((w): w is Worker => !!w)
    if (!list.length) return text('nothing to wait for')
    const limitMs = Math.min(Math.max(Number(e.timeoutSec ?? 30), 1), 60) * 1000
    const start = Date.now()
    const any = e.mode === 'any'
    for (;;) {
      const done = list.filter(w => w.state !== 'running')
      if (any ? done.length > 0 : done.length === list.length) break
      if (Date.now() - start >= limitMs) break
      await $.clock.sleep(100)
      if (next.signal.aborted) break
    }
    const parts: string[] = []
    for (const w of list) {
      if (w.state !== 'running') {
        w.isReported = true
        parts.push(await digest(w))
        continue
      }
      // Still running: one line of what changed since the last wait, never the whole digest again.
      const dSteps = w.steps - (w.waitSteps ?? 0)
      const dFiles = w.files.size - (w.waitFiles ?? 0)
      const quiet = w.lastAt ? Math.round((Date.now() - w.lastAt) / 1000) : 0
      parts.push(
        `[${w.id}] running ${elapsed(w)} · steps ${w.steps}${dSteps ? ` (+${dSteps})` : ' (no new steps)'} · files ${w.files.size}${dFiles ? ` (+${dFiles})` : ''} · now: ${w.last}${quiet > 20 ? ` · quiet ${quiet}s` : ''}`,
      )
      w.waitSteps = w.steps
      w.waitFiles = w.files.size
    }
    const still = list.filter(w => w.state === 'running').length
    if (still) parts.push(`(${still} still running; call pi_wait again)`)
    return text(parts.join('\n\n'))
  })

  on('tool.call', { tool: 'mcp__omp-conductor__pi_send' }, async (_$, e) => {
    const w = pick(e)
    if (!w) return text(`no worker ${String(e.id)}`, true)
    if (w.state === 'running') return text(`${w.id} is still running`, true)
    if (!w.send && !w.session) return text(`${w.id} has no live process or session id to continue`, true)
    const notReady = await ensureSetup()
    if (notReady) return text(notReady, true)
    if (running() >= MAX_WORKERS) return text(`max ${MAX_WORKERS} concurrent workers`, true)
    const message = String(e.message ?? '').trim()
    if (!message) return text('message is required', true)
    if (typeof e.maxMinutes === 'number' && e.maxMinutes > 0) w.maxMinutes = Math.min(e.maxMinutes, 240)
    if (e.effort !== undefined) {
      if (!THINKING_LEVELS.includes(String(e.effort))) return text(`effort must be one of ${THINKING_LEVELS.join(', ')}`, true)
      w.effort = String(e.effort)
    }
    w.texts = []
    w.errors = []
    B?.launch(w, message)
    await sync()
    return text(`sent to ${w.id}${w.send ? ' (same process, context kept)' : ' (process was stopped; resuming its saved session)'}`)
  })

  on('tool.call', { tool: 'mcp__omp-conductor__pi_diff' }, async ($, e) => {
    const w = pick(e)
    if (!w) return text(`no worker ${String(e.id)}`, true)
    const cap = Math.min(Math.max(Number(e.maxChars ?? 8000), 500), 40000)
    // No isolated worktree (a non-git dir, or worktree:false): diff against the originals the guard saved.
    if (!w.worktree) return text((await B?.nonGitDiff(w, cap)) ?? 'not ready', false)
    const cwdW = workDir(w)
    const stat = await $.process.run(['git', 'diff', '--stat', 'HEAD'], { cwd: cwdW, timeoutMs: 20_000 })
    const diff = await $.process.run(['git', 'diff', 'HEAD'], { cwd: cwdW, timeoutMs: 20_000 })
    const untracked = await $.process.run(['git', 'ls-files', '--others', '--exclude-standard'], {
      cwd: cwdW,
      timeoutMs: 20_000,
    })
    // New files have no tracked diff: show their content as additions (first few, so a review sees what was created).
    const fresh = untracked.stdout.split('\n').filter(f => f && !/__pycache__|\.pyc$/.test(f))
    const created: string[] = []
    for (const f of fresh.slice(0, 8)) {
      const d = await $.process.run(['git', 'diff', '--no-index', '--', '/dev/null', f], { cwd: cwdW, timeoutMs: 20_000 }).catch(() => undefined)
      if (d?.stdout.trim()) created.push(clip(d.stdout.trimEnd(), 2500))
    }
    const out = [
      stat.stdout.trim() || '(no tracked changes)',
      fresh.length ? `untracked (${fresh.length}):\n${fresh.join('\n')}` : '',
      clip(diff.stdout, cap),
      ...created,
      fresh.length > 8 ? `(content shown for the first 8 of ${fresh.length} new files)` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    return text(out)
  })

  on('tool.call', { tool: 'mcp__omp-conductor__pi_kill' }, async (_$, e) => {
    const w = pick(e)
    if (!w) return text(`no worker ${String(e.id)}`, true)
    if (w.state !== 'running') return text(`${w.id} is already ${w.state}`)
    w.killed = true
    void w.send?.({ type: 'abort' })
    w.stop?.()
    finish(w)
    return text(`killed ${w.id}`)
  })

  on('tool.call', { tool: 'mcp__omp-conductor__pi_merge' }, async (_$, e) => {
    const w = pick(e)
    if (!w) return text(`no worker ${String(e.id)}`, true)
    if (w.state === 'running') return text(`${w.id} is still running`, true)
    if (!w.worktree || !w.branch) return text(`${w.id} has no worktree to merge`, true)
    if (!B) return text('not ready', true)
    const dirty = await B.git(['status', '--porcelain', '--untracked-files=no'], w.dir)
    if (dirty?.stdout.trim()) {
      return text(`main tree ${w.dir} has tracked changes; commit or stash them first`, true)
    }
    // Stage the worker's changes but never build junk: an untracked __pycache__ from running tests would otherwise
    // be committed by every worker and conflict add/add at the second merge.
    await B.git(['add', '-A', '--', '.', ':(exclude,glob)**/__pycache__/**', ':(exclude,glob)**/*.pyc', ':(exclude,glob)**/.DS_Store'], w.worktree)
    // A conflict hand-off (below) leaves a merge in progress in the worktree; never commit it with markers still in files.
    const markers = await B.git(['grep', '-n', '-E', '^(<<<<<<<|>>>>>>>) ', '--', '.'], w.worktree)
    if (markers?.exitCode === 0 && markers.stdout.trim()) {
      return text(`${w.id} still has conflict markers (${markers.stdout.trim().split('\n').slice(0, 4).join('; ')}). pi_send it to resolve them, then pi_merge again.`, true)
    }
    const merging = (await B.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], w.worktree))?.exitCode === 0
    const staged = await B.git(['diff', '--cached', '--quiet'], w.worktree)
    if (staged?.exitCode === 1 || merging) {
      const c = await B.git(
        ['-c', 'user.name=omp-conductor', '-c', 'user.email=omp-conductor@localhost', 'commit', '--allow-empty', '-m', merging ? `Merge ${w.dir.split('/').pop()} into ${w.branch} (${w.id})` : `${w.title} (${w.id})`],
        w.worktree,
      )
      if (c?.exitCode !== 0) return text(`commit failed: ${c?.stderr.trim() ?? 'unknown'}`, true)
    }
    const ahead = await B.git(['rev-list', '--count', `HEAD..${w.branch}`], w.dir)
    if (Number(ahead?.stdout.trim() ?? 0) === 0) return text(`${w.id}: nothing to merge`)
    const msg = String(e.message ?? `omp merge ${w.id}: ${w.title}`)
    const m = await B.git(
      ['-c', 'user.name=omp-conductor', '-c', 'user.email=omp-conductor@localhost', 'merge', '--no-ff', '-m', msg, w.branch],
      w.dir,
    )
    if (m?.exitCode !== 0) {
      const files = await B.git(['diff', '--name-only', '--diff-filter=U'], w.dir)
      const list = files?.stdout.trim().split('\n').join(', ') || m?.stderr.trim()
      await B.git(['merge', '--abort'], w.dir)
      // Hand the conflict to the worker: merge the main tree's current commit into its worktree, leaving markers
      // for it to resolve. The main tree stays clean either way.
      const head = (await B.git(['rev-parse', 'HEAD'], w.dir))?.stdout.trim()
      const pre = head
        ? await B.git(['-c', 'user.name=omp-conductor', '-c', 'user.email=omp-conductor@localhost', 'merge', '--no-commit', '--no-ff', head], w.worktree)
        : undefined
      const handed = pre && pre.exitCode !== 0 && (await B.git(['diff', '--name-only', '--diff-filter=U'], w.worktree))?.stdout.trim()
      return text(
        `merge conflict, aborted; the main tree is untouched. conflicting: ${list}.` +
          (handed
            ? `\nThe same conflict is now in ${w.id}'s worktree as <<<<<<< markers (${handed.split('\n').join(', ')}). pi_send ${w.id}: "resolve the conflict markers in those files so both sides' intent is kept, edit files only (no git), run the tests, and report", wait, review pi_diff, then pi_merge ${w.id} again.`
            : `\nCould not stage the conflict in the worktree; merge by hand or re-spawn on the current branch.`),
        true,
      )
    }
    const stat = await B.git(['diff', '--stat', 'HEAD~1', 'HEAD'], w.dir)
    return text(`merged ${w.branch} into ${w.dir}\n${stat?.stdout.trim() ?? ''}`)
  })

  on('tool.call', { tool: 'mcp__omp-conductor__pi_cleanup' }, async ($, e) => {
    const w = pick(e)
    if (!w) return text(`no worker ${String(e.id)}`, true)
    if (w.state === 'running') return text(`${w.id} is still running; pi_kill it first`, true)
    if (!B) return text('not ready', true)
    if (w.worktree && w.branch) {
      if (e.force !== true) {
        const dirty = await B.git(['status', '--porcelain'], w.worktree)
        const ahead = await B.git(['rev-list', '--count', `HEAD..${w.branch}`], w.dir)
        if (dirty?.stdout.trim() || Number(ahead?.stdout.trim() ?? 0) > 0) {
          return text(`${w.id} has unmerged work; pi_merge it first or pass force:true`, true)
        }
      }
      const rm = await B.git(['worktree', 'remove', '--force', w.worktree], w.dir)
      if (rm?.exitCode !== 0) return text(`worktree remove failed: ${rm?.stderr.trim()}`, true)
      await B.git(['branch', '-D', w.branch], w.dir)
    }
    w.stop?.()
    await $.process.run(['rm', '-rf', `${agentDir}/tmp/${sid}-${w.id}`, `${agentDir}/snap/${sid}-${w.id}`, `${agentDir}/run/${sid}-${w.id}.marker`], { timeoutMs: 15_000 }).catch(() => undefined)
    workers.delete(w.id)
    await sync()
    return text(`cleaned up ${w.id}`)
  })

}
