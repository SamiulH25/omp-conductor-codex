import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Ajv } from 'ajv'
import { fileURLToPath } from 'node:url'
import { register } from './conductor.js'
import { createRuntime } from './runtime.js'

const host = createRuntime(fileURLToPath(new URL('../', import.meta.url)))
register(host.on)
await host.start()
const server = new Server({ name: 'omp-conductor-codex', version: '1.1.0' }, { capabilities: { tools: {} } })
const ajv = new Ajv({ strict: false, allErrors: true })
const validators = new Map(host.tools.map(t => [t.name, ajv.compile(t.inputSchema)]))
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: host.tools }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params
  try {
    const validate = validators.get(name)
    if (!validate) throw new Error(`Unknown tool: ${name}`)
    if (!validate(args)) throw new Error(`Invalid arguments: ${ajv.errorsText(validate.errors)}`)
    const result = await host.call(name, args)
    return { content: [{ type: 'text', text: result?.deny ?? result?.result ?? result?.text ?? '' }], isError: !!result?.deny }
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
  }
})
let closing = false
async function close() { if (closing) return; closing = true; await host.close(); await server.close() }
process.on('SIGINT', () => { void close().then(() => process.exit(0)) })
process.on('SIGTERM', () => { void close().then(() => process.exit(0)) })
server.onclose = () => { void close() }
await server.connect(new StdioServerTransport())
