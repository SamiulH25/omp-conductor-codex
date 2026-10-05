import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export type PanelWorker = {
  id: string; title: string; agent: string; state: string; act?: string; last: string
  startedAt: number; endedAt?: number; lastAt?: number; files: string[]
  tokens: number; cost: number; warnings: string[]; error?: string
  tps?: number; avgTps?: number; spark: number[]; maxMinutes?: number
}
export type PanelSnapshot = {
  version: 1; sessionId: string; panelId: string; pid: number; at: number; closed: boolean
  cwd: string; model: string; effort: string
  ledger: { cost: number; tokens: number; spawned: number }; workers: PanelWorker[]
}

export async function readPanels(dataDir: string, panelId?: string): Promise<PanelSnapshot[]> {
  const root = join(dataDir, 'panels')
  const groups = panelId ? [panelId] : await readdir(root).catch(() => [])
  const result: PanelSnapshot[] = []
  for (const group of groups) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(group)) continue
    const dir = join(root, group)
    const names = await readdir(dir).catch(() => [])
    for (const name of names.filter(n => n.endsWith('.json'))) {
      try {
        const value = JSON.parse(await readFile(join(dir, name), 'utf8'))
        if (value.version === 1 && value.panelId === group && typeof value.sessionId === 'string' && Array.isArray(value.workers) && value.ledger) result.push(value)
      } catch { /* An unavailable or incomplete snapshot is retried on the next frame. */ }
    }
  }
  return result.sort((a, b) => b.at - a.at)
}

// Never let file names, worker output or titles inject terminal control sequences.
export const clean = (text: unknown) => String(text ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
const widthOf = (ch: string) => /\p{Mark}/u.test(ch) ? 0 : /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1
export function fit(text: unknown, width: number) {
  const chars = Array.from(clean(text)), total = chars.reduce((n, ch) => n + widthOf(ch), 0)
  if (total <= width) return chars.join('')
  let used = 0, out = ''
  for (const ch of chars) { const size = widthOf(ch); if (used + size > width - 1) break; out += ch; used += size }
  return out + '~'
}
const count = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const money = (n: number) => n > 0 ? `$${n.toFixed(n >= 1 ? 2 : 4)}` : 'plan'
const elapsed = (w: PanelWorker, now: number) => { const sec = Math.max(0, Math.floor(((w.endedAt ?? now) - w.startedAt) / 1000)); return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s` }
const palette = { running: '\x1b[36m', done: '\x1b[32m', failed: '\x1b[31m', killed: '\x1b[90m' }
export function renderPanel(snapshots: PanelSnapshot[], options: { width: number; now?: number; frame?: number; color?: boolean }): string[] {
  const width = Math.max(8, options.width), now = options.now ?? Date.now(), frame = options.frame ?? 0
  const line = (s: unknown) => fit(s, width)
  const output = [line('PI CONDUCTOR'), line('Workers beside Codex'), '-'.repeat(Math.min(width, 44))]
  if (!snapshots.length) return [...output, '', line('Waiting for Codex...'), '', line('Ask Codex to use Pi Conductor.'), line('Worker activity appears here.'), '', line('q close panel  |  j/k scroll')]
  const live = snapshots.filter(s => !s.closed && now - s.at < 5000)
  const recent = snapshots.filter(s => live.includes(s) || now - s.at < 60 * 60_000).slice(0, 12)
  if (!recent.length) return [...output, '', line('No recent sessions.'), line('Launch: conductor -- -C PROJECT')]
  const all = recent.flatMap(s => s.workers)
  const running = live.flatMap(s => s.workers).filter(w => w.state === 'running').length
  const total = recent.reduce((sum, s) => ({ tokens: sum.tokens + s.ledger.tokens, cost: sum.cost + s.ledger.cost }), { tokens: 0, cost: 0 })
  output.push(line(`${running} running / ${all.length} workers`), line(`${count(total.tokens)} tokens  |  ${money(total.cost)}`), line(`${live.length ? 'LIVE' : 'OFFLINE - saved state'}  |  ${new Date(recent[0].at).toLocaleTimeString()}`), '')
  for (const snapshot of recent) {
    output.push(line(`Model: ${snapshot.model.split('/').at(-1)}`), line(`Effort: ${snapshot.effort}`))
    if (!snapshot.workers.length) output.push(line('Ready. No workers yet.'), '')
    for (let i = 0; i < snapshot.workers.length; i++) {
      const w = snapshot.workers[i], stale = snapshot.closed || now - snapshot.at >= 5000
      const state = w.state === 'running' && stale ? 'interrupted' : w.state
      const eyes = state === 'done' ? '^ ^' : state === 'failed' ? 'x x' : state === 'killed' || state === 'interrupted' ? '- -' : w.act === 'edit' ? '> <' : w.act === 'bash' ? 'O O' : frame % 16 === 0 ? '- -' : 'o o'
      const face = ['(', '[', '{', '<'][i % 4] + eyes + [')', ']', '}', '>'][i % 4]
      const spin = state === 'running' ? '|/-\\'[frame % 4] : state === 'done' ? '+' : '!'
      const title = line(`${face} ${spin} ${w.id} ${w.agent} / ${state}`)
      output.push(options.color ? `${palette[state] ?? '\x1b[90m'}${title}\x1b[0m` : title, line(w.title), line(`${elapsed(w, now)}  ${w.files.length} files  ${count(w.tokens)} tok`))
      const speed = state === 'running' ? w.tps : w.avgTps
      const graph = w.spark?.length ? w.spark.map(n => '._-=+*#@'[Math.min(7, Math.floor(n / Math.max(1, ...w.spark) * 7))]).join('') : ''
      output.push(line(`${speed ? `${Math.round(speed)} tok/s  ` : ''}${money(w.cost)}  ${graph}`))
      if (state === 'running' && w.maxMinutes) {
        const progress = Math.min(1, (now - w.startedAt) / (w.maxMinutes * 60_000)), size = Math.max(3, Math.min(20, width - 9))
        output.push(line(`[${'#'.repeat(Math.floor(progress * size))}${'.'.repeat(size - Math.floor(progress * size))}] time`))
      }
      output.push(line(w.last || 'Starting...'))
      if (w.error) output.push(line(`Error: ${w.error}`))
      for (const warning of w.warnings ?? []) output.push(line(`! ${warning}`))
      output.push('')
    }
  }
  output.push(line('q close panel  |  j/k scroll'))
  return output
}
export function demoSnapshot(now = Date.now()): PanelSnapshot {
  return { version: 1, sessionId: 'demo', panelId: 'demo', pid: 0, at: now, closed: false, cwd: '/demo', model: 'opencode-go/deepseek-v4.1-flash', effort: 'low', ledger: { tokens: 18450, cost: 0, spawned: 4 }, workers: ['running', 'done', 'failed', 'killed'].map((state, i) => ({ id: `w${i + 1}`, title: ['Implementing inventory slots', 'Reviewing the save format', 'Checking input bindings', 'Stopped by supervisor'][i], agent: i === 1 ? 'review' : 'dev', state, act: 'edit', last: state === 'running' ? 'edit src/inventory.ts' : 'Worker finished', startedAt: now - 125000, endedAt: state === 'running' ? undefined : now - 5000, files: ['src/example.ts'], tokens: 4000 + i * 400, cost: 0, warnings: state === 'failed' ? ['verify FAILED: input test'] : [], spark: [12, 35, 24, 48, 39, 55], tps: 55, avgTps: 41, maxMinutes: 20 })) }
}
