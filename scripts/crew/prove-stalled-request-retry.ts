#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'stalled-request-'))
Object.assign(process.env, { MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'fixture-key-000', MERCURY_AGENT_IDLE_MINUTES: '0.05' })
for (const name of ['MERCURY_HOME', 'MERCURY_SCRIPTED_STREAM', 'NODE_ENV']) delete process.env[name]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const model = 'claude-fable-5-1'
const serverCode = String.raw`
import { createServer } from 'node:http'
const model = 'claude-fable-5-1'
const sse = (type, body) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...body }) + '\n\n'
const start = () => sse('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
const delta = text => sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
const end = () => sse('content_block_stop', { index: 0 }) + sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }) + sse('message_stop', {})
let scenario = 'recover', requests = [], cancelled = 0, closed = []
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url?.includes('/messages')) { res.end('{}'); return }
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
    let answered = false
    const finish = body => { answered = true; res.end(body) }
    closed.push(new Promise(done => res.on('close', () => { if (!answered) cancelled++; done() })))
    process.send({ event: 'request' })
    if (scenario === 'recover' && requests.length === 2) { finish(start() + delta('recovered answer') + end()); return }
    if (scenario === 'partial') { res.write(start() + delta('partial answer')); return }
    if (scenario === 'usage') { res.write(sse('message_start', { message: { id: 'msg_usage', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 10, output_tokens: 1 } } })); return }
    if (scenario === 'tool') { res.write(start() + sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_fixture', name: 'Read', input: {} } })); return }
    if (scenario === 'thinking') { res.write(start() + sse('content_block_start', { index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } }) + sse('content_block_delta', { index: 1, delta: { type: 'thinking_delta', thinking: 'still thinking' } })); return }
    if (scenario === 'active') {
      res.write(start())
      let ticks = 0
      const timer = setInterval(() => { res.write(delta('alive ')); if (++ticks === 20) { clearInterval(timer); finish(end()) } }, 200)
      res.on('close', () => clearInterval(timer))
    }
  })
})
process.on('message', async message => {
  if (message.op === 'reset') { scenario = message.scenario; requests = []; cancelled = 0; closed = [] }
  if (message.op === 'read') await Promise.all(closed)
  if (message.op === 'close') { server.closeAllConnections(); server.close(() => process.exit(0)); return }
  process.send({ id: message.id, requests, cancelled })
})
server.listen(0, '127.0.0.1', () => process.send({ event: 'ready', port: server.address().port }))
`
const server = spawn('node', ['--input-type=module', '-e', serverCode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true })
let onRequest: (() => void) | undefined
let serial = 0
const pending = new Map<number, (value: { requests: Record<string, any>[]; cancelled: number }) => void>()
const ready = new Promise<number>(done => server.on('message', (message: any) => {
  if (message.event === 'ready') done(message.port)
  else if (message.event === 'request') onRequest?.()
  else if (message.id !== undefined) { pending.get(message.id)?.(message); pending.delete(message.id) }
}))
const command = async (op: string, scenario?: string) => {
  const id = ++serial
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([new Promise<{ requests: Record<string, any>[]; cancelled: number }>(done => { pending.set(id, done); server.send({ id, op, scenario }) }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture command did not settle: ' + op)), 30_000) })])
  } finally { clearTimeout(timer) }
}
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${await ready}`
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
await import('../../src/tasks.ts')
const { runAgent } = await import('../../src/tools/AgentTool/runAgent.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { enableDebugLogging, getDebugLogPath } = await import('../../src/utils/debug.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
enableDebugLogging()
let failures = 0
const check = (name: string, ok: boolean, detail: unknown = ''): void => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`) }
const textOf = (rows: any[]) => rows.filter(row => row.type === 'assistant').flatMap(row => row.message.content ?? []).map(block => block.text ?? '').join('')
async function drive(kind: string) {
  await command('reset', kind)
  let state = { ...getDefaultAppState(), effortValue: 'max' }
  const owner = new AbortController()
  onRequest = kind === 'operator' ? () => owner.abort(new Error('operator stopped')) : undefined
  const previous = createAssistantMessage({ content: [{ type: 'thinking', thinking: 'prior thought', signature: 'fixture-signed-thinking' }, { type: 'text', text: 'previous answer' }] as never })
  previous.message.model = model
  const context = {
    abortController: owner,
    options: { commands: [], tools: [], engineModel: model, thinkingConfig: { type: 'adaptive' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => state, setAppState: (update: any) => { state = update(state) }, setAppStateForTasks: (update: any) => { state = update(state) },
    messages: [], readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
  }
  const rows: any[] = []
  let error = ''
  const logStart = readFileSync(getDebugLogPath(), 'utf8').length
  await runWithCwdOverride(home, async () => {
    try {
      for await (const row of runAgent({ agentDefinition: { agentType: 'stall-fixture', source: 'projectSettings', getSystemPrompt: () => 'Continue the fixture.' } as never, promptMessages: [createUserMessage({ content: 'continue the previous answer' })], forkContextMessages: [createUserMessage({ content: 'earlier question' }), previous], toolUseContext: context as never, canUseTool: (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never, isAsync: false, querySource: 'agent:custom', availableTools: [], model, effortOverride: 'max', override: { agentId: `stall-${kind}`, userContext: {}, systemContext: {}, systemPrompt: ['Continue the fixture.'] } })) rows.push(row)
    } catch (caught) { error = String(caught) }
  })
  const evidence = await command('read')
  return { rows, error, ...evidence, log: readFileSync(getDebugLogPath(), 'utf8').slice(logStart), ownerAborted: owner.signal.aborted }
}
try {
  const recovered = await drive('recover')
  check('empty stalled request is resent once and the crewmate finishes', recovered.error === '' && recovered.requests.length === 2 && textOf(recovered.rows).includes('recovered answer'), { error: recovered.error, requests: recovered.requests.length })
  check('the retry carries exactly the same continuation, tools, model and posture', recovered.requests.length === 2 && JSON.stringify(recovered.requests[0]) === JSON.stringify(recovered.requests[1]), recovered.requests.map(request => ({ model: request.model, thinking: request.thinking, effort: request.output_config, max_tokens: request.max_tokens })))
  check('max effort and signed thinking survive the resend', recovered.requests.length === 2 && recovered.requests.every(request => request.output_config?.effort === 'max' && request.thinking?.type === 'adaptive' && JSON.stringify(request.messages).includes('fixture-signed-thinking')), recovered.requests.map(request => request.messages))
  check('only the request was aborted, with one named retry in the debug log', !recovered.ownerAborted && recovered.cancelled === 1 && (recovered.log.match(/stalled request — retrying the same request/g) ?? []).length === 1, { cancelled: recovered.cancelled, ownerAborted: recovered.ownerAborted, lines: recovered.log.split('\n').filter(line => /stalled/.test(line)) })
  console.log('refusals')
  const twice = await drive('twice')
  check('two silent attempts stop the crewmate without a third request', twice.requests.length === 2 && /first and second/.test(twice.error), { requests: twice.requests.length, error: twice.error })
  const partial = await drive('partial')
  check('content before silence is not replayed or sent to another model', partial.requests.length === 1 && partial.error.includes('no progress') && textOf(partial.rows).includes('partial answer'), { requests: partial.requests.length, error: partial.error, text: textOf(partial.rows) })
  for (const kind of ['usage', 'tool', 'thinking']) {
    const produced = await drive(kind)
    check(`${kind} before silence forbids replay`, produced.requests.length === 1 && produced.error.includes('no progress'), { requests: produced.requests.length, error: produced.error })
  }
  const active = await drive('active')
  check('a stream producing events stays alive beyond the watchdog interval', active.error === '' && active.requests.length === 1 && textOf(active.rows).includes('alive'), { requests: active.requests.length, error: active.error })
  const stopped = await drive('operator')
  check('an operator stop is never converted into a retry', stopped.ownerAborted && stopped.requests.length === 1 && !stopped.log.includes('stalled request — retrying'), { requests: stopped.requests.length, error: stopped.error })
  console.log(`${failures ? 'FAIL' : 'PASS'} stalled request recovery; failures=${failures}`)
} finally {
  const stopped = new Promise<void>(done => server.once('exit', () => done()))
  server.send({ op: 'close' })
  await stopped
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
