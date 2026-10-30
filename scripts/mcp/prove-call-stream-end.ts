#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-stream-end-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { connectToServer, callMCPToolWithUrlElicitationRetry, clearServerCache, DEFAULT_MCP_CALL_IDLE_MINUTES } = await import('../../src/services/mcp/client.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — stream-end prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

const calls: Record<string, number> = {}
const encoder = new TextEncoder()
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  idleTimeout: 120,
  async fetch(req) {
    const mode = new URL(req.url).pathname.slice(1)
    if (req.method !== 'POST') return new Response('', { status: 405 })
    const message = (await req.json().catch(() => null)) as { id?: number; method?: string; params?: { protocolVersion?: string } } | null
    if (!message || message.id === undefined) return new Response(null, { status: 202 })
    const result = (value: unknown) => Response.json({ jsonrpc: '2.0', id: message.id, result: value })
    if (message.method === 'initialize') return result({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stream-end', version: '1' } })
    if (message.method === 'tools/list') return result({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] })
    if (message.method === 'tools/call') {
      calls[mode] = (calls[mode] ?? 0) + 1
      const sse = { headers: { 'content-type': 'text/event-stream' } }
      if (mode === 'reset') return new Response(new ReadableStream({ start(c) { setTimeout(() => c.error(new Error('reset')), 50) } }), sse)
      if (mode === 'clean-close') return new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(': keepalive\n\n')); setTimeout(() => c.close(), 50) } }), sse)
      if (mode === 'answered') {
        return new Response(new ReadableStream({ start(c) {
          c.enqueue(encoder.encode(': keepalive\n\n'))
          setTimeout(() => {
            c.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'answered over the stream' }] } })}\n\n`))
            c.close()
          }, 50)
        } }), sse)
      }
    }
    return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
  },
})

console.log('a remote tools/call whose response stream ends without an answer settles at once, sent once, with the cause named')
check(`the idle watchdog stays at its default (${DEFAULT_MCP_CALL_IDLE_MINUTES} minutes), so a fast settlement is the fix and not the watchdog`, process.env.MERCURY_MCP_CALL_IDLE_MINUTES === undefined)

for (const mode of ['reset', 'clean-close'] as const) {
  const config = { type: 'http', scope: 'dynamic', url: `http://127.0.0.1:${server.port}/${mode}` } as const
  const connection = await connectToServer(`stream-end-${mode}`, config)
  try {
    check(`${mode}: the server connects`, connection.type === 'connected')
    const started = Date.now()
    const outcome = await callMCPToolWithUrlElicitationRetry({ client: connection, tool: 'echo', args: {}, signal: new AbortController().signal })
      .then(() => 'resolved', (error: Error) => error.message)
    const elapsed = Date.now() - started
    check(`${mode}: the call settles within three seconds`, elapsed < 3000, `${elapsed}ms`)
    check(`${mode}: tools/call was sent once`, calls[mode] === 1, String(calls[mode]))
    check(`${mode}: the words name the stream end and the unknown outcome`, outcome.includes('closed the response stream before answering') && outcome.includes('unknown outcome') && outcome.includes('inspect the effect before retrying'), outcome)
  } finally {
    await clearServerCache(`stream-end-${mode}`, config)
  }
}

{
  const config = { type: 'http', scope: 'dynamic', url: `http://127.0.0.1:${server.port}/answered` } as const
  const connection = await connectToServer('stream-end-answered', config)
  try {
    const outcome = await callMCPToolWithUrlElicitationRetry({ client: connection, tool: 'echo', args: {}, signal: new AbortController().signal })
      .then(result => `ok ${JSON.stringify(result.content)}`, (error: Error) => error.message)
    check('a stream that answers and then closes is a plain answer', outcome.startsWith('ok') && outcome.includes('answered over the stream'), outcome)
    const again = await callMCPToolWithUrlElicitationRetry({ client: connection, tool: 'echo', args: {}, signal: new AbortController().signal })
      .then(result => `ok ${JSON.stringify(result.content)}`, (error: Error) => error.message)
    check('…and so is the next one on the same connection', again.startsWith('ok'), again)
  } finally {
    await clearServerCache('stream-end-answered', config)
  }
}

server.stop(true)
clearTimeout(watchdog)
console.log(failures === 0 ? '\nPASS prove-call-stream-end' : `\nFAIL prove-call-stream-end (${failures})`)
process.exit(failures === 0 ? 0 : 1)
