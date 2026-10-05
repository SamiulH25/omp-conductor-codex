import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { demoSnapshot, fit, readPanels, renderPanel } from './panel.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const help = `Pi Conductor companion\n\n  conductor [launch] [--detach] -- [codex arguments]\n  conductor dashboard [--once] [--demo] [--panel ID] [--data-dir PATH]\n\nExamples:\n  ./bin/conductor -- -C ~/my-project\n  ./bin/conductor dashboard --demo\n\nRequires tmux for launch. Ctrl-b then left/right changes panes; q closes the panel.\nThe launcher uses codex --no-daemon to pass panel identity to its MCP server.\nDashboard reads local snapshots and never calls a model.\n`
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
function tmux(args: string[], allowFailure = false) {
  const r = spawnSync('tmux', args, { encoding: 'utf8' })
  if ((r.error || r.status !== 0) && !allowFailure) throw new Error((r.error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'tmux is not installed. Install tmux, then run conductor again.' : `${args[0]}: ${r.stderr.trim() || String(r.error ?? 'tmux failed')}`)
  return r.stdout?.trim() ?? ''
}
function value(args: string[], name: string) { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} requires a value`); return args[i + 1] }
async function dashboard(args: string[]) {
  const dataDir = resolve(value(args, '--data-dir') ?? process.env.OMP_CONDUCTOR_DATA_DIR ?? join(homedir(), '.codex/plugin-data/omp-conductor-codex'))
  const panelId = value(args, '--panel') ?? process.env.OMP_CONDUCTOR_PANEL_ID
  if (panelId && !/^[a-zA-Z0-9_-]{1,100}$/.test(panelId)) throw new Error('Invalid panel ID')
  const watchPane = value(args, '--watch-pane'), demo = args.includes('--demo'), once = args.includes('--once') || !process.stdout.isTTY
  let frame = 0, offset = 0, stopped = false
  const restore = () => { if (stopped) return; stopped = true; if (!once) { process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l'); if (process.stdin.isTTY) process.stdin.setRawMode(false); process.stdin.pause() } }
  if (!once) {
    process.stdout.write('\x1b[?1049h\x1b[?25l')
    if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', b => { const key = b.toString(); if (key === 'q' || key === '\x03' || key === '\x04') restore(); else if (key === 'j' || key === '\x1b[B') offset += 3; else if (key === 'k' || key === '\x1b[A') offset = Math.max(0, offset - 3) }) }
    process.on('SIGINT', restore); process.on('SIGTERM', restore)
  }
  try {
    do {
      const snapshots = demo ? [demoSnapshot()] : await readPanels(dataDir, panelId)
      const rows = renderPanel(snapshots, { width: process.stdout.columns ?? 48, frame: frame++, color: !once })
      const height = Math.max(1, (process.stdout.rows ?? 30) - 1)
      offset = Math.min(offset, Math.max(0, rows.length - height))
      if (once) { process.stdout.write(rows.join('\n') + '\n'); break }
      const visible = rows.slice(offset, offset + Math.max(1, height - 1))
      while (visible.length < height - 1) visible.push('')
      visible.push(fit(`q close | j/k scroll${offset ? ` (${offset + 1}/${rows.length})` : ''}`, process.stdout.columns ?? 48))
      process.stdout.write('\x1b[H\x1b[2J' + visible.join('\r\n'))
      if (watchPane && frame % 4 === 0 && !tmux(['list-panes', '-a', '-F', '#{pane_id}'], true).split('\n').includes(watchPane)) break
      await new Promise(r => setTimeout(r, 250))
    } while (!stopped)
  } finally { restore() }
}
async function launch(args: string[]) {
  const separator = args.indexOf('--'), options = separator >= 0 ? args.slice(0, separator) : []
  const codexArgs = separator >= 0 ? args.slice(separator + 1) : args
  const detached = options.includes('--detach')
  if (!process.stdin.isTTY && !detached) throw new Error('Launch needs an interactive terminal. Use dashboard --once for plain output, or launch --detach -- for a detached tmux session.')
  const codex = process.env.OMP_CONDUCTOR_CODEX_BIN ?? 'codex'
  const probe = spawnSync(codex, ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) throw new Error('Codex is not installed or not on PATH.')
  tmux(['-V'])
  const panelId = randomUUID(), dataDir = resolve(process.env.OMP_CONDUCTOR_DATA_DIR ?? join(homedir(), '.codex/plugin-data/omp-conductor-codex'))
  const env = { ...process.env, OMP_CONDUCTOR_PANEL_ID: panelId, OMP_CONDUCTOR_DATA_DIR: dataDir }
  const codexCommand = ['env', `OMP_CONDUCTOR_PANEL_ID=${panelId}`, `OMP_CONDUCTOR_DATA_DIR=${dataDir}`, codex, '--no-daemon', ...codexArgs].map(quote).join(' ')
  const panelCommand = (pane: string) => [process.execPath, join(root, 'dist/companion.mjs'), 'dashboard', '--panel', panelId, '--data-dir', dataDir, '--watch-pane', pane].map(quote).join(' ')
  if (process.env.TMUX && !detached) {
    const main = tmux(['display-message', '-p', '#{pane_id}'])
    const side = tmux(['split-window', '-h', '-l', '35%', '-d', '-P', '-F', '#{pane_id}', '-t', main, '-c', process.cwd(), panelCommand(main)])
    tmux(['set-option', '-p', '-t', side, 'remain-on-exit', 'off'])
    try {
      const child = spawn(codex, ['--no-daemon', ...codexArgs], { stdio: 'inherit', env })
      const forward = () => child.kill('SIGTERM'), keepLauncher = () => {}
      // Ctrl-C reaches Codex through the shared terminal process group; keep the launcher alive.
      process.on('SIGTERM', forward); process.on('SIGINT', keepLauncher)
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => { process.exitCode = code ?? 1; resolve() }) })
      process.removeListener('SIGTERM', forward); process.removeListener('SIGINT', keepLauncher)
    } finally { tmux(['kill-pane', '-t', side], true) }
    return
  }
  const session = `conductor-${panelId.slice(0, 8)}`
  let created = false
  try {
    const main = tmux(['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session, '-n', 'Codex + Conductor', '-x', String(process.stdout.columns ?? 140), '-y', String(process.stdout.rows ?? 40), '-c', process.cwd(), codexCommand]); created = true
    tmux(['set-option', '-w', '-t', session, 'remain-on-exit', 'off'])
    tmux(['split-window', '-h', '-l', '35%', '-d', '-t', main, '-c', process.cwd(), panelCommand(main)])
    tmux(['select-pane', '-t', main])
    if (detached) { console.log(`Started ${session}\nAttach: tmux attach -t ${session}`); return }
    const attached = spawnSync('tmux', ['attach-session', '-t', session], { stdio: 'inherit' })
    process.exitCode = attached.status ?? 1
  } catch (e) { if (created) tmux(['kill-session', '-t', session], true); throw e }
}
const args = process.argv.slice(2)
try {
  const ownArgs = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
  if (ownArgs.includes('--help') || ownArgs.includes('-h')) console.log(help)
  else if (args[0] === 'dashboard') await dashboard(args.slice(1))
  else if (args[0] === 'demo') await dashboard(['--demo', ...args.slice(1)])
  else await launch(args[0] === 'launch' ? args.slice(1) : args)
} catch (e) { console.error(`conductor: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1 }
