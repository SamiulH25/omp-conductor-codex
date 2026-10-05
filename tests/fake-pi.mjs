#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
if (process.argv.includes('--version')) { console.log('fake-pi 1.0'); process.exit(0) }
if (process.argv.includes('--list-models')) { console.log('provider model context\nopencode-go deepseek-v4.1-flash 1M'); process.exit(0) }
const emit = e => process.stdout.write(JSON.stringify(e) + '\n')
const session = join(process.env.TMPDIR, 'fake-session')
const saved = existsSync(session) ? readFileSync(session, 'utf8') : 'fixture-session'
writeFileSync(session, saved)
createInterface({ input: process.stdin }).on('line', line => {
  const cmd = JSON.parse(line)
  if (cmd.type === 'get_state') emit({ type: 'response', command: 'get_state', success: true, data: { sessionId: saved } })
  if (cmd.type !== 'prompt') return
  if (cmd.message.startsWith('CRASH')) process.exit(3)
  if (cmd.message.startsWith('HANG')) return
  const write = /^WRITE (\S+) (.*)/.exec(cmd.message)
  if (write) {
    writeFileSync(write[1], write[2] + '\n')
    emit({ type: 'tool_execution_start', toolCallId: '1', toolName: 'write', args: { path: write[1] } })
    emit({ type: 'tool_execution_end', toolCallId: '1', toolName: 'write', result: { content: [] } })
  }
  const report = process.argv[process.argv.indexOf('--tools') + 1]?.includes('edit') ? 'SUMMARY:\n- fixture completed' : 'FINDINGS:\nfixture evidence'
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: report } })
  emit({ type: 'turn_end', message: { usage: { input: 12, output: 8, cost: { total: 0 } } } })
  emit({ type: 'agent_end' }); emit({ type: 'agent_settled' })
})
