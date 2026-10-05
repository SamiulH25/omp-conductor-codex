import { spawn as spawnChild } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, stat, realpath, readdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

export type Register = (on: (...args: any[]) => void) => void
export const atom = <T>(_key: unknown, initial: T) => ({ value: structuredClone(initial) })
export const read = async <T>(_runtime: unknown, a: { value: T }): Promise<T> => a.value
export const update = async <T>(_runtime: unknown, a: { value: T }, fn: (v: T) => T) => { a.value = fn(a.value) }

function terminate(child: ReturnType<typeof spawnChild>) {
  if (!child.pid) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 1000)
  timer.unref()
}

export function createRuntime(root: string, options: { dataDir?: string; sessionId?: string; cwd?: string } = {}) {
  const home = homedir()
  const dataDir = resolve(options.dataDir ?? process.env.OMP_CONDUCTOR_DATA_DIR ?? join(home, '.codex', 'plugin-data', 'omp-conductor-codex'))
  const requestedSessionId = options.sessionId ?? process.env.CODEX_THREAD_ID ?? randomUUID()
  const sessionId = /^[a-zA-Z0-9_-]{1,100}$/.test(requestedSessionId) ? requestedSessionId : createHash('sha256').update(requestedSessionId).digest('hex')
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  const tools: any[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const children = new Set<ReturnType<typeof spawnChild>>()
  let writeChain: Promise<any> = Promise.resolve()
  const storePath = (key: string) => join(dataDir, 'store', createHash('sha256').update(key).digest('hex') + '.json')
  const store = {
    async get(key: string) { await writeChain; try { return JSON.parse(await readFile(storePath(key), 'utf8')).value } catch (e) { if (e.code === 'ENOENT') return undefined; throw e } },
    async set(key: string, value: unknown) {
      const serialized = JSON.stringify({ key, value })
      const run = writeChain.then(async () => {
        await mkdir(join(dataDir, 'store'), { recursive: true, mode: 0o700 })
        const path = storePath(key), temp = path + '.' + randomUUID() + '.tmp'
        await writeFile(temp, serialized, { mode: 0o600 }); await rename(temp, path)
      })
      writeChain = run.catch(() => {}); await run
    },
    async delete(key: string) { await writeChain; await unlink(storePath(key)).catch(e => { if (e.code !== 'ENOENT') throw e }) },
    async keys() { await writeChain; const names = await readdir(join(dataDir, 'store')).catch(() => []); return Promise.all(names.filter(n => n.endsWith('.json')).map(async n => JSON.parse(await readFile(join(dataDir, 'store', n), 'utf8')).key)) },
  }
  const track = (child: ReturnType<typeof spawnChild>) => { children.add(child); child.once('close', () => children.delete(child)); return child }
  const runtime = {
    home, dataDir, plugin: { root }, session: { id: async () => sessionId }, store,
    fs: {
      read: (path: string) => readFile(path, 'utf8'),
      async write(path: string, body: string) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, body, { mode: 0o600 }) },
      async exists(path: string) { try { await stat(path); return true } catch { return false } },
      async stat(path: string, _options: unknown) { return { ...(await stat(path)), realPath: await realpath(path) } },
    },
    process: {
      run(argv: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return new Promise((resolve, reject) => {
          const child = track(spawnChild(argv[0], argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }))
          let stdout = '', stderr = '', timedOut = false
          child.stdout!.on('data', b => { stdout = (stdout + b).slice(-2_000_000) })
          child.stderr!.on('data', b => { stderr = (stderr + b).slice(-2_000_000) })
          const timer = setTimeout(() => { timedOut = true; terminate(child) }, opts.timeoutMs ?? 30_000)
          child.once('error', e => { clearTimeout(timer); reject(e) })
          child.once('close', code => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: timedOut ? 124 : code ?? 1 }) })
        })
      },
      spawn(opts: { argv: string[]; cwd: string; env: Record<string, string> }) {
        const child = track(spawnChild(opts.argv[0], opts.argv.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }))
        const queue: any[] = []; let wake: (() => void) | undefined; let closed = false, exitCode: number | null = null
        const put = (v: any) => { queue.push(v); wake?.(); wake = undefined }
        child.stdout!.on('data', b => put({ stream: 'stdout', text: b.toString() }))
        child.stderr!.on('data', b => put({ stream: 'stderr', text: b.toString() }))
        child.stdin!.on('error', () => {})
        child.once('error', e => put({ stream: 'stderr', text: e.message }))
        child.once('close', code => { closed = true; exitCode = code; wake?.() })
        return {
          write(body: string): Promise<void> { return new Promise((resolve, reject) => { child.stdin!.write(body, e => e ? reject(e) : resolve()) }) },
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<any> { while (!queue.length && !closed) await new Promise<void>(r => { wake = r }); return queue.length ? { done: false, value: queue.shift() } : { done: true, value: { code: exitCode } } },
              async return(): Promise<any> { terminate(child); return { done: true, value: { code: exitCode } } },
            }
          },
        }
      },
    },
    clock: {
      after(ms: number, fn: () => void) { const t = setTimeout(() => { timers.delete(t); fn() }, ms); timers.add(t); return { cancel: () => { clearTimeout(t); timers.delete(t) } } },
      every(ms: number, fn: () => void) { const t = setInterval(fn, ms); timers.add(t); return { cancel: () => { clearInterval(t); timers.delete(t) } } },
      sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
    },
    tool: { async register(tool: any) { tools.push(tool) } },
    command: { async register(command: any) { tools.push({ name: command.name.replaceAll('-', '_'), description: command.description, inputSchema: { type: 'object', properties: { value: { type: 'string', description: 'Omit to show; set a new value or reset.' } }, additionalProperties: false } }) } },
  }
  const on = (event: string, filterOrFn: any, maybeFn?: any) => {
    const fn = maybeFn ?? filterOrFn, filter = maybeFn ? filterOrFn : undefined
    const name = event === 'tool.call' ? filter.tool.split('__').at(-1) : event === 'command.run' ? filter.command.replaceAll('-', '_') : event
    handlers.set(name, fn)
  }
  const next: any = async (e: any) => e
  next.signal = new AbortController().signal
  let mutationChain: Promise<any> = Promise.resolve()
  return {
    runtime, on, tools, sessionId,
    async start() { await mkdir(dataDir, { recursive: true, mode: 0o700 }); await handlers.get('session.start')?.(runtime, { cwd: options.cwd ?? process.cwd() }, next) },
    async call(name: string, args: any = {}) {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`Unknown tool: ${name}`)
      const invoke = () => handler(runtime, name === 'pi_model' || name === 'pi_effort' ? { args: args.value ?? '' } : args, next)
      // Serialize mutations so async worktree/setup operations cannot exceed the cap or race a merge.
      if (!['pi_wait', 'pi_status', 'pi_digest', 'pi_diff'].includes(name)) {
        const call = mutationChain.then(invoke); mutationChain = call.catch(() => {}); return call
      }
      return invoke()
    },
    async close() {
      for (const t of timers) { clearTimeout(t); clearInterval(t) }; timers.clear()
      await handlers.get('session.end')?.(runtime, {}, next)
      for (const child of children) terminate(child)
      await writeChain
    },
  }
}
