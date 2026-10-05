import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { clean, demoSnapshot, renderPanel, readPanels } from '../dist/test/panel.mjs'

const command = (...args) => execFileSync(process.execPath, [resolve('dist/companion.mjs'), ...args], { encoding: 'utf8' })
test('dashboard shows worker states, metrics and warnings without terminal injection', () => {
  const snapshot = demoSnapshot(); snapshot.workers[0].title = '\x1b[2Jmalicious\x1b]0;title\x07 text'
  const rows = renderPanel([snapshot], { width: 44, color: false })
  assert.match(rows.join('\n'), /running/); assert.match(rows.join('\n'), /done/)
  assert.match(rows.join('\n'), /failed/); assert.match(rows.join('\n'), /killed/)
  assert.match(rows.join('\n'), /verify FAILED/); assert.match(rows.join('\n'), /55 tok\/s/)
  assert.equal(rows.some(r => r.includes('\x1b') || r.includes('\x07')), false)
  assert.ok(rows.every(r => r.length <= 44))
  assert.equal(clean('\x1b[2Jhello\nworld'), 'hello world')
})
test('stale heartbeat marks running work interrupted', () => {
  const snapshot = demoSnapshot(10000), rows = renderPanel([snapshot], { width: 48, now: 20000 })
  assert.match(rows.join('\n'), /OFFLINE/); assert.match(rows.join('\n'), /interrupted/)
})
test('plain dashboard preview exits cleanly and narrow output fits', () => {
  const text = command('dashboard', '--demo', '--once'); assert.match(text, /PI CONDUCTOR/); assert.equal(text.includes('\x1b'), false)
  assert.ok(renderPanel([demoSnapshot()], { width: 15 }).every(r => r.length <= 15))
  assert.match(command('--help'), /Requires tmux/)
})
test('invalid snapshots and groups are ignored; panel selection stays isolated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panel-read-'))
  try {
    await mkdir(join(dir, 'panels', 'one'), { recursive: true }); await mkdir(join(dir, 'panels', 'two'))
    const s = demoSnapshot(); s.panelId = 'one'
    await writeFile(join(dir, 'panels/one/valid.json'), JSON.stringify(s)); await writeFile(join(dir, 'panels/one/broken.json'), '{')
    const other = { ...s, panelId: 'two' }; await writeFile(join(dir, 'panels/two/valid.json'), JSON.stringify(other))
    assert.equal((await readPanels(dir, 'one')).length, 1)
    assert.deepEqual(await readPanels(dir, '../one'), [])
    assert.equal((await readPanels(dir)).length, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('real tmux launcher opens a companion split, preserves args, and closes after Codex exits', { skip: spawnSync('tmux', ['-V']).status !== 0 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-tmux-'))
  const env = { ...process.env, TMUX_TMPDIR: dir, TMUX: '', OMP_CONDUCTOR_CODEX_BIN: join(dir, 'codex'), OMP_CONDUCTOR_DATA_DIR: join(dir, 'data'), OMP_FAKE_LOG: join(dir, 'args.json'), OMP_FAKE_STOP: join(dir, 'stop') }
  await writeFile(env.OMP_CONDUCTOR_CODEX_BIN, `#!/usr/bin/env node\nimport {writeFileSync,existsSync} from 'node:fs';\nif(process.argv.includes('--version')){console.log('codex-fixture');process.exit(0)}\nwriteFileSync(process.env.OMP_FAKE_LOG,JSON.stringify({args:process.argv.slice(2),panel:process.env.OMP_CONDUCTOR_PANEL_ID,data:process.env.OMP_CONDUCTOR_DATA_DIR}));\nconsole.log('CODEX FIXTURE');\nsetInterval(()=>{if(existsSync(process.env.OMP_FAKE_STOP))process.exit(0)},100);\n`, { mode: 0o755 })
  // ESM fake executable in an isolated directory.
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  const tmux = (...args) => spawnSync('tmux', args, { env, encoding: 'utf8' })
  let session
  try {
    const tricky = "project with 'quote' $(must-not-run)"
    const result = execFileSync(process.execPath, [resolve('dist/companion.mjs'), 'launch', '--detach', '--', '-C', tricky], { env, encoding: 'utf8' })
    session = /Started (conductor-[a-z0-9-]+)/.exec(result)[1]
    let panes = []
    for (let i = 0; i < 40; i++) {
      panes = tmux('list-panes', '-t', session, '-F', '#{pane_id}').stdout.trim().split('\n')
      if (panes.length === 2 && tmux('capture-pane', '-p', '-t', panes[1]).stdout.includes('PI CONDUCTOR')) break
      await new Promise(r => setTimeout(r, 50))
    }
    assert.equal(panes.length, 2)
    assert.match(tmux('capture-pane', '-p', '-t', panes[0]).stdout, /CODEX FIXTURE/)
    assert.match(tmux('capture-pane', '-p', '-t', panes[1]).stdout, /PI CONDUCTOR/)
    const record = JSON.parse(execFileSync('cat', [env.OMP_FAKE_LOG], { encoding: 'utf8' }))
    assert.deepEqual(record.args, ['--no-daemon', '-C', tricky]); assert.ok(record.panel); assert.equal(record.data, env.OMP_CONDUCTOR_DATA_DIR)
    await writeFile(env.OMP_FAKE_STOP, '')
    for (let i = 0; i < 50 && tmux('has-session', '-t', session).status === 0; i++) await new Promise(r => setTimeout(r, 100))
    assert.notEqual(tmux('has-session', '-t', session).status, 0)

    // Existing tmux windows retain unrelated panes when the launcher finishes.
    await rm(env.OMP_FAKE_STOP, { force: true })
    session = 'conductor-existing'
    const guard = tmux('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session, '-x', '140', '-y', '40', 'sleep 60').stdout.trim()
    const q = s => "'" + s.replaceAll("'", "'\\''") + "'"
    const launchCommand = [process.execPath, resolve('dist/companion.mjs'), '--', '-C', 'existing-mode'].map(q).join(' ')
    const main = tmux('split-window', '-v', '-P', '-F', '#{pane_id}', '-t', guard, launchCommand).stdout.trim()
    for (let i = 0; i < 40; i++) {
      panes = tmux('list-panes', '-t', session, '-F', '#{pane_id}').stdout.trim().split('\n')
      if (panes.length === 3 && panes.some(p => tmux('capture-pane', '-p', '-t', p).stdout.includes('PI CONDUCTOR'))) break
      await new Promise(r => setTimeout(r, 50))
    }
    assert.equal(panes.length, 3)
    assert.match(tmux('capture-pane', '-p', '-t', main).stdout, /CODEX FIXTURE/)
    const dashboardPane = panes.find(p => tmux('capture-pane', '-p', '-t', p).stdout.includes('PI CONDUCTOR'))
    tmux('send-keys', '-t', dashboardPane, 'q')
    for (let i = 0; i < 30; i++) {
      panes = tmux('list-panes', '-t', session, '-F', '#{pane_id}').stdout.trim().split('\n')
      if (panes.length === 2) break
      await new Promise(r => setTimeout(r, 50))
    }
    assert.equal(panes.length, 2); assert.ok(panes.includes(main)); assert.ok(panes.includes(guard))
    await writeFile(env.OMP_FAKE_STOP, '')
    for (let i = 0; i < 50; i++) {
      panes = tmux('list-panes', '-t', session, '-F', '#{pane_id}').stdout.trim().split('\n')
      if (panes.length === 1) break
      await new Promise(r => setTimeout(r, 100))
    }
    assert.deepEqual(panes, [guard])
  } finally { if (session) tmux('kill-session', '-t', session); tmux('kill-server'); await rm(dir, { recursive: true, force: true }) }
})
