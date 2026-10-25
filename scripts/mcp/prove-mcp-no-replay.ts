#!/usr/bin/env bun
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mcp-no-replay-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_MCP_TOOL_TIMEOUT_MS = '1000'
if (typeof Bun !== 'undefined') {
  const output = join(scratch, 'proof.mjs')
  const built = await Bun.build({ entrypoints: [import.meta.path], target: 'node', outdir: scratch, naming: 'proof.mjs', external: ['sharp', 'jsonc-parser'] })
  if (!built.success) throw new Error(built.logs.join('\n'))
  symlinkSync(join(process.cwd(), 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const child = spawnSync('node', [output], { env: process.env, stdio: 'inherit' })
  rmSync(scratch, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const mcp = await import('../../src/services/mcp/client.ts')
let calls = 0
const invocations: unknown[] = []
let mode: 'drop' | 'timeout' | 'reject' | 'ok' = 'drop'
let rejected = false
const cancelled: unknown[] = []
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const msg = JSON.parse(raw)
  const reply = (result: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })) }
  if (msg.method === 'server/discover') { res.writeHead(404).end(); return }
  if (msg.method === 'initialize') { reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'action-fixture', version: '1' } }); return }
  if (msg.method === 'tools/list') { reply({ tools: [{ name: 'record', description: 'Records an action', inputSchema: { type: 'object', properties: {} } }] }); return }
  if (msg.method === 'notifications/cancelled') cancelled.push(msg.params.requestId)
  if (msg.method !== 'tools/call') { res.writeHead(202).end(); return }
  if (mode === 'reject' && !rejected) { rejected = true; res.writeHead(404).end(JSON.stringify({ error: { code: -32001, message: 'Session not found' } })); return }
  calls++
  invocations.push({ mode, msg })
  if (mode === 'drop') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' }); res.write('{'); setTimeout(() => res.destroy(), 20); return }
  if (mode === 'timeout') return
  reply({ content: [{ type: 'text', text: 'recorded' }] })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const config = { type: 'http', url: `http://127.0.0.1:${(server.address() as any).port}/mcp`, scope: 'dynamic' } as const
let failures = 0
function check(label: string, ok: boolean) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++ }
try {
  for (const testMode of ['drop', 'timeout', 'reject'] as const) {
    mode = testMode; calls = 0
    const connection = await mcp.connectToServer(`action-fixture-${testMode}`, config)
    if (connection.type !== 'connected') throw new Error(JSON.stringify(connection))
    let requestSignal: AbortSignal | undefined
    if (testMode === 'timeout') {
      const callTool = connection.client.callTool.bind(connection.client)
      connection.client.callTool = ((params, options) => {
        requestSignal = options?.signal
        return callTool(params, { ...options, timeout: 10_000 })
      }) as typeof connection.client.callTool
    }
    const tools = await mcp.fetchToolsForClient(connection)
    const tool = tools[0]!
    let text = ''; let failed = false
    try {
      const result = await tool.call({}, { abortController: new AbortController(), options: { isNonInteractiveSession: true } } as any, (() => {}) as any, { message: { content: [] } } as any)
      text = JSON.stringify(result)
    } catch (error) { failed = true; text = String(error) }
    console.log(`${testMode}: invocations=${calls} ${text}`)
    check(`${testMode}: exactly one effect`, calls === 1)
    if (testMode === 'reject') check('non-executing session rejection can reconnect and retry', !failed && text.includes('recorded'))
    else {
      check(`${testMode}: error survives tool wrapper`, failed)
      check(`${testMode}: unknown outcome names action and recovery`, /unknown outcome/i.test(text) && text.includes('action-fixture') && text.includes('record') && text.includes('inspect the effect before retrying'))
      if (process.env.PROOF_RESULT_DIR) writeFileSync(join(process.env.PROOF_RESULT_DIR, `mcp-${testMode}.json`), JSON.stringify({ error: text.replace(/^\w+: /, '') }))
    }
    if (testMode === 'timeout') {
      check('local timeout aborts the SDK request signal before returning', requestSignal?.aborted === true)
      const id = (invocations.at(-1) as { msg: { id: unknown } }).msg.id
      const deadline = Date.now() + 1_000
      while (!cancelled.includes(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      check('local timeout sends notifications/cancelled for the original request', cancelled.includes(id))
    }
    await mcp.clearServerCache(`action-fixture-${testMode}`, config)
  }
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(scratch, { recursive: true, force: true })
}
if (failures) console.log(JSON.stringify(invocations))
process.exit(failures ? 1 : 0)
