import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) delete process.env[key]
const home = mkdtempSync(join(tmpdir(), 'fold-heartbeat-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
let requests = 0
let heartbeats = 0
const summary = 'The parser handles quoted commas and all 14 checks passed. Continue with CLI verification and preserve the pending test command.'
const event = (type: string, value: unknown): string => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`
const server = createServer((req, res) => {
  if (!req.url?.split('?')[0]?.endsWith('/v1/messages')) { res.writeHead(404).end('{}'); return }
  req.resume()
  req.on('end', () => {
    const id = `msg_fixture_${++requests}`
    const usage = { input_tokens: 20, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(event('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-fable-5-1', content: [], stop_reason: null, stop_sequence: null, usage } }))
    const beat = setInterval(() => { heartbeats++; res.write(event('ping', { type: 'ping' })) }, 250)
    const finish = setTimeout(() => {
      res.write(event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      res.write(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: summary } }))
      res.write(event('content_block_stop', { type: 'content_block_stop', index: 0 }))
      res.write(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
      res.end(event('message_stop', { type: 'message_stop' }))
    }, 11_000)
    res.once('close', () => { clearInterval(beat); clearTimeout(finish) })
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { compactConversation, setFoldBoundsForTests } = await import('../../src/services/compact/compact.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
let failures = 0
const check = (label: string, ok: boolean, detail: unknown = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
const activity: number[] = []
const context: any = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, setSDKStatus: (value: any) => { if (typeof value?.streamActivity === 'number') activity.push(value.streamActivity) }, messages: [], readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024), options: { tools: [], commands: [], mcpClients: [], engineModel: 'claude-fable-5-1', maxThinkingTokens: 0, thinkingConfig: { type: 'adaptive' }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
const messages = [createUserMessage({ content: 'Preserve the parser result and continue with CLI verification.' })]
const cache = { systemPrompt: asSystemPrompt(['Synthetic heartbeat relay proof.']), userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: messages }
const guard = setTimeout(() => context.abortController.abort(), 60_000)
setFoldBoundsForTests({ stallMs: 5_000, ingestMsPer1kTokens: 0 })
try {
  const start = Date.now()
  const result = await compactConversation(messages, context, cache, false)
  check('the cache fork survives more than two silence budgets on heartbeats alone', requests === 1 && Date.now() - start >= 11_000, { requests, ms: Date.now() - start })
  check('the whole summary survives', result.summaryMessages.some(row => String(row.message.content).includes(summary)))
  check('the actual session receives the same raw-byte activity relay', activity.length >= 3 && heartbeats >= 20, { activity: activity.length, heartbeats })
} catch (error) {
  check('the live stream completes', false, String(error))
} finally {
  clearTimeout(guard)
  setFoldBoundsForTests(null)
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold-heartbeat-relay: ${failures} failures`)
process.exit(failures ? 1 : 0)
