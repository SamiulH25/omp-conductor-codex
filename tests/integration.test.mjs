import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, chmod, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRuntime } from '../dist/test/runtime.mjs'
import { register } from '../dist/test/conductor.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

let fixture, repo, host, oldPath, oldKey
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim()
const call = (name, args) => host.call(name, args)
const wait = id => call('pi_wait', { ids: [id], timeoutSec: 5 })
const spawn = async task => { const r = await call('pi_spawn', { task, dir: repo, agent: 'dev', checks: [] }); assert.ok(r.result, r.deny); return /started (w\d+)/.exec(r.result)[1] }
before(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'conductor-test-')); repo = join(fixture, 'repo'); await mkdir(repo)
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test')
  await writeFile(join(repo, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'initial')
  const bin = join(fixture, 'bin'); await mkdir(bin); await copyFile(new URL('./fake-pi.mjs', import.meta.url), join(bin, 'pi')); await chmod(join(bin, 'pi'), 0o755)
  oldPath = process.env.PATH; oldKey = process.env.OPENCODE_GO_API_KEY; process.env.PATH = bin + ':' + oldPath; process.env.OPENCODE_GO_API_KEY = 'fixture-only'
  host = createRuntime(resolve('.'), { dataDir: join(fixture, 'data'), sessionId: 'test-session', cwd: repo }); register(host.on); await host.start()
  const r = await call('pi_dict', { action: 'set', dir: repo, entries: [{ term: 'layout', definition: 'base.txt is the fixture file.' }] }); assert.ok(r.result, r.deny)
})
after(async () => { await host?.close(); process.env.PATH = oldPath; if (oldKey === undefined) delete process.env.OPENCODE_GO_API_KEY; else process.env.OPENCODE_GO_API_KEY = oldKey; await rm(fixture, { recursive: true, force: true }) })

test('isolated edit, persistent follow-up, diff, merge and cleanup', async () => {
  const id = await spawn('WRITE new.txt first'); assert.match((await wait(id)).result, /done/)
  await assert.rejects(readFile(join(repo, 'new.txt')))
  assert.match((await call('pi_diff', { id })).result, /\+first/)
  assert.match((await call('pi_cleanup', { id })).deny, /unmerged/)
  assert.match((await call('pi_send', { id, message: 'WRITE new.txt revised' })).result, /same process/)
  await wait(id); assert.match((await call('pi_diff', { id })).result, /\+revised/)
  assert.match((await call('pi_merge', { id })).result, /merged/)
  assert.equal(await readFile(join(repo, 'new.txt'), 'utf8'), 'revised\n')
  assert.match((await call('pi_cleanup', { id })).result, /cleaned/)
})
test('concurrent spawn respects four-worker cap; kill stops each process', async () => {
  const ids = await Promise.all(Array.from({ length: 4 }, () => spawn('HANG')))
  assert.match((await call('pi_spawn', { task: 'HANG', dir: repo, agent: 'dev' })).deny, /max 4/)
  for (const id of ids) { assert.match((await call('pi_kill', { id })).result, /killed/); await call('pi_cleanup', { id }) }
})
test('worker crash fails instead of staying running', async () => {
  const id = await spawn('CRASH'); assert.match((await wait(id)).result, /failed/); await call('pi_cleanup', { id })
})
test('failed verification is visible in digest', async () => {
  const r = await call('pi_spawn', { task: 'WRITE verified.txt content', dir: repo, agent: 'dev', checks: [], verify: 'exit 7' }); const id = /started (w\d+)/.exec(r.result)[1]
  assert.match((await wait(id)).result, /verify FAILED|verify FAILED \(exit 7\)/)
  await call('pi_cleanup', { id, force: true })
})
test('merge conflict aborts the main checkout and protects unmerged work', async () => {
  const a = await spawn('WRITE base.txt left'), b = await spawn('WRITE base.txt right'); await wait(a); await wait(b)
  assert.match((await call('pi_merge', { id: a })).result, /merged/)
  assert.match((await call('pi_merge', { id: b })).deny, /merge conflict, aborted/)
  assert.equal(await readFile(join(repo, 'base.txt'), 'utf8'), 'left\n'); assert.equal(git('status', '--porcelain'), '')
  await call('pi_cleanup', { id: a }); await call('pi_cleanup', { id: b, force: true })
})
test('stdio MCP initializes, lists tools, validates inputs and handles settings', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.mjs')], env: { ...process.env, OMP_CONDUCTOR_DATA_DIR: join(fixture, 'mcp-data'), CODEX_THREAD_ID: 'mcp-fixture' } })
  const client = new Client({ name: 'test', version: '1.0.0' }); await client.connect(transport)
  try {
    const { tools } = await client.listTools(); assert.ok(tools.some(t => t.name === 'pi_spawn')); assert.ok(tools.some(t => t.name === 'pi_model'))
    const invalid = await client.callTool({ name: 'pi_spawn', arguments: { task: 42 } }); assert.equal(invalid.isError, true)
    const effort = await client.callTool({ name: 'pi_effort', arguments: { value: 'high' } }); assert.match(effort.content[0].text, /high/)
    const model = await client.callTool({ name: 'pi_model', arguments: {} }); assert.match(model.content[0].text, /deepseek/)
  } finally { await client.close() }
})
test('saved worker and settings recover after a server restart', async () => {
  const id = await spawn('WRITE restored.txt saved'); await wait(id)
  await call('pi_effort', { value: 'medium' })
  await host.close()
  host = createRuntime(resolve('.'), { dataDir: join(fixture, 'data'), sessionId: 'test-session', cwd: repo }); register(host.on); await host.start()
  assert.match((await call('pi_digest', { id })).result, /fixture completed/)
  assert.match((await call('pi_effort')).text, /medium/)
  assert.match((await call('pi_send', { id, message: 'WRITE restored.txt resumed' })).result, /resuming/)
  await wait(id); assert.match((await call('pi_diff', { id })).result, /\+resumed/)
  await call('pi_cleanup', { id, force: true })
})
test('toolbox preserves literal arguments and records a passing check', async () => {
  const scratch = join(fixture, 'check'); await mkdir(scratch)
  const config = join(scratch, 'checks.json')
  await writeFile(config, JSON.stringify({ cwd: repo, checks: { literal: { command: "printf '%s\\n' {args}", purpose: 'argument quoting', timeoutSec: 5 } } }))
  const literal = "a'b $(printf unexpected)"
  const out = execFileSync(process.execPath, [resolve('bin/check'), 'literal', literal], { encoding: 'utf8', env: { ...process.env, PI_CHECKS_FILE: config, TMPDIR: scratch } })
  assert.match(out, /PASS/); assert.equal(await readFile(join(scratch, 'check-literal.log'), 'utf8'), literal + '\n')
  assert.equal(JSON.parse((await readFile(join(scratch, 'checks.jsonl'), 'utf8')).trim()).ok, true)
})
