#!/usr/bin/env bun
// gate-watch: src/services/providers/openai/openaiSocketTransport.ts src/services/providers/openai/openaiClient.ts src/services/providers/openai/openaiCallModel.ts src/utils/settings/types.ts docs/SETTINGS.md scripts/settings/settings-schema.json
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'openai-socket-road-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'openai-socket-road-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const k of ['NODE_ENV', 'MERCURY_BARE', 'MERCURY_MODEL', 'ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN', 'MERCURY_HOME', 'MERCURY_WIRE_DUMP']) delete process.env[k]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — openai socket road prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

console.log('============================================================')
console.log(' the optional WebSocket road for the OpenAI API-key Responses requests: off by default, one connection per conversation, only the new input against the previous response, HTTP on any fault before the response begins')
console.log(' S1 the setting is off by default: the request posts over HTTP, bytes as before, no socket opened')
console.log(' S2 routing.openai.transport = websocket: the first request rides response.create over one socket with the whole input and store:false; the next turn sends previous_response_id and only the new items; a tool round sends only the function_call_output; the reply settles the same')
console.log(' S3 the fallbacks: a refused handshake, an error frame before the response, a close before the response — each rides HTTP once with nothing generated twice; a lost connection cache replays the whole input on the socket; a fault after output began is the stream fault, never a second generation')
console.log(' S4 the connection\'s life: a socket past the rotation age is replaced and the whole input sent again; the subscription road never takes the socket; the setting is in the register, the schema and the docs')
console.log('============================================================')

const MODEL = 'gpt-5.6-sol'
type Frame = Record<string, unknown>
type Turn = { text?: string; call?: { id: string; name: string; args: string }; usage?: { input: number; output: number } }
type Mode = 'serve' | 'error-before' | 'close-before' | 'close-mid' | 'not-found-once' | 'not-found-always' | 'garbage-mid' | 'error-shape' | 'refuse-upgrade'

const sockets: Array<{ authorization: string | null; frames: Frame[]; responseIds: string[]; closed: boolean; closeCode?: number }> = []
const posts: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
let mode: Mode = 'serve'
let turns: Turn[] = []
let generations = 0
let notFoundAnswered = false

function responseEvents(turn: Turn, ordinal: number): Frame[] {
  const out: Frame[] = [{ type: 'response.created', response: { id: `resp_${ordinal}` } }]
  const output: Frame[] = []
  if (turn.call !== undefined) {
    const itemId = `fc_${ordinal}`
    const item = { type: 'function_call', id: itemId, call_id: turn.call.id, name: turn.call.name, arguments: turn.call.args }
    out.push({ type: 'response.output_item.added', item: { ...item, arguments: '' } })
    out.push({ type: 'response.function_call_arguments.delta', item_id: itemId, delta: turn.call.args })
    out.push({ type: 'response.output_item.done', item })
    output.push(item)
  } else {
    const item = { type: 'message', id: `msg_${ordinal}`, role: 'assistant', content: [{ type: 'output_text', text: turn.text ?? '' }] }
    out.push({ type: 'response.output_text.delta', item_id: item.id, delta: turn.text ?? '' })
    out.push({ type: 'response.output_item.done', item })
    output.push(item)
  }
  out.push({ type: 'response.completed', response: { id: `resp_${ordinal}`, output, usage: { input_tokens: turn.usage?.input ?? 8, output_tokens: turn.usage?.output ?? 3, input_tokens_details: { cached_tokens: 0 } } } })
  return out
}

const sse = (frame: Frame): string => `data: ${JSON.stringify(frame)}\n\n`

const server = Bun.serve<{ index: number }>({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return Response.json({ models: [{ slug: MODEL, display_name: 'GPT-5.6-Sol', supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }], default_reasoning_level: 'low', visibility: 'list', priority: 1 }] })
    }
    if (url.pathname !== '/v1/responses') return new Response('{}', { status: 404 })
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (mode === 'refuse-upgrade') return new Response(JSON.stringify({ error: { message: 'no websocket here' } }), { status: 404 })
      const index = sockets.length
      sockets.push({ authorization: req.headers.get('authorization'), frames: [], responseIds: [], closed: false })
      if (srv.upgrade(req, { data: { index } })) return undefined as unknown as Response
      return new Response('upgrade failed', { status: 500 })
    }
    return req.json().then(body => {
      posts.push({ authorization: req.headers.get('authorization'), body: body as Record<string, unknown> })
      const turn = turns.shift() ?? { text: 'the HTTP road answered' }
      generations += 1
      return new Response(responseEvents(turn, posts.length + 100).map(sse).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
  },
  websocket: {
    open() {},
    message(ws, raw) {
      const entry = sockets[ws.data.index]!
      const frame = JSON.parse(String(raw)) as Frame
      entry.frames.push(frame)
      if (frame.type !== 'response.create') return
      if (mode === 'error-before') {
        ws.send(JSON.stringify({ type: 'error', status: 500, error: { type: 'server_error', code: 'fixture_refused', message: 'the fixture refused this one' } }))
        return
      }
      if (mode === 'close-before') {
        ws.close(1009, 'message too large')
        return
      }
      if (mode === 'error-shape') {
        ws.send(JSON.stringify({ type: 'error', error: 'not an object', status: 'bad' }))
        return
      }
      if (mode === 'not-found-always') {
        ws.send(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'previous_response_not_found', message: 'gone', param: 'previous_response_id' } }))
        return
      }
      if (mode === 'not-found-once' && typeof frame.previous_response_id === 'string' && !notFoundAnswered) {
        notFoundAnswered = true
        ws.send(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'previous_response_not_found', message: `Previous response with id '${String(frame.previous_response_id)}' not found.`, param: 'previous_response_id' } }))
        return
      }
      const turn = turns.shift() ?? { text: 'the socket road answered' }
      generations += 1
      entry.responseIds.push(`resp_${generations}`)
      const events = responseEvents(turn, generations)
      if (mode === 'close-mid') {
        ws.send(JSON.stringify(events[0]))
        ws.send(JSON.stringify(events[1]))
        ws.close(1011, 'the fixture dropped the stream')
        return
      }
      if (mode === 'garbage-mid') {
        ws.send(JSON.stringify(events[0]))
        ws.send(JSON.stringify(events[1]))
        ws.send('{this is not json')
        return
      }
      for (const event of events) ws.send(JSON.stringify(event))
    },
    close(ws, code) {
      const entry = sockets[ws.data.index]
      if (entry) {
        entry.closed = true
        entry.closeCode = code
      }
    },
  },
})
const base = `http://127.0.0.1:${server.port}`
process.env.MERCURY_OPENAI_API_BASE = `${base}/v1`
process.env.OPENAI_API_KEY = 'sk-fixture-openai-key-not-a-real-key'

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const socketRoadModule = await import('../../src/services/providers/openai/openaiSocketTransport.ts').catch(() => null)
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { z } = await import('zod/v4')

type AnyMsg = Record<string, unknown> & { type?: string }
function makeTool(name: string): never {
  return {
    name,
    async description() { return 'rig tool' },
    async prompt() { return 'rig tool' },
    inputSchema: z.object({ command: z.string().optional() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() { return { result: true } },
    async call(input: Record<string, unknown>) { return { data: `ran:${(input?.command as string) ?? ''}` } },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}
async function call(messages: unknown[], owner = 'conversation-a'): Promise<{ rows: AnyMsg[]; errors: AnyMsg[] }> {
  const rows: AnyMsg[] = []
  const errors: AnyMsg[] = []
  const stream = routedCallModel({
    messages: messages as never,
    systemPrompt: asSystemPrompt(['fixture system prompt']),
    thinkingConfig: { type: 'disabled' },
    tools: [makeTool('Bash')] as never,
    signal: AbortSignal.timeout(30_000),
    options: {
      model: MODEL,
      querySource: 'sdk',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      enablePromptCaching: false,
      ownerKey: owner,
      async getToolPermissionContext() { return getEmptyToolPermissionContext() },
    } as never,
  })
  for await (const ev of stream) {
    const m = ev as AnyMsg
    if (m.type !== 'assistant') continue
    rows.push(m)
    if (m.isApiErrorMessage === true) errors.push(m)
  }
  return { rows, errors }
}
const textOf = (rows: AnyMsg[]): string => rows.filter(m => m.isApiErrorMessage !== true).flatMap(m => ((m.message as { content?: Array<{ type: string; text?: string }> }).content ?? [])).filter(b => b.type === 'text').map(b => b.text ?? '').join('')
const replyRow = (rows: AnyMsg[]): AnyMsg | undefined => rows.find(m => m.isApiErrorMessage !== true)
const setTransport = (value: 'http' | 'websocket' | undefined): void => {
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify(value === undefined ? {} : { routing: { openai: { transport: value } } }))
  resetSettingsCache()
}
const lastCreate = (): Frame | undefined => sockets.at(-1)?.frames.filter(f => f.type === 'response.create').at(-1)

section('S1 off by default')
{
  setTransport(undefined)
  check('the register reads the road as off', socketRoadModule?.openaiSocketRoadChosen() === false)
  turns = [{ text: 'hello over http' }]
  const r = await call([createUserMessage({ content: 'say hello' })])
  check('the request posted over HTTP and no socket opened', posts.length === 1 && sockets.length === 0, `posts=${posts.length} sockets=${sockets.length}`)
  check('the reply settled', textOf(r.rows) === 'hello over http' && r.errors.length === 0, JSON.stringify(r.rows.map(m => JSON.stringify(m.message).slice(0, 100))))
  check('the posted body keeps the stateless contract (store:false, stream:true, no previous_response_id)', posts[0]?.body.store === false && posts[0]?.body.stream === true && !('previous_response_id' in (posts[0]?.body ?? {})))
  check('the setting spelled http reads as off too', (setTransport('http'), socketRoadModule?.openaiSocketRoadChosen() === false))
}

check('the socket road exists (src/services/providers/openai/openaiSocketTransport.ts)', socketRoadModule !== null)
if (socketRoadModule === null) {
  server.stop(true)
  console.log(`\n${failures} FAIL — ${checks} checks (the socket road is absent; the remaining sections need it)`)
  process.exit(1)
}
const socketRoad = socketRoadModule

section('S2 the socket road')
{
  setTransport('websocket')
  socketRoad._resetOpenaiSocketRoadForTest()
  check('the register reads the road as chosen', socketRoad.openaiSocketRoadChosen() === true)
  turns = [{ text: 'hello over the socket', usage: { input: 40, output: 5 } }]
  const first = [createUserMessage({ content: 'say hello' })]
  const r1 = await call(first)
  check('one socket opened and no HTTP post went out', sockets.length === 1 && posts.length === 1, `sockets=${sockets.length} posts=${posts.length}`)
  check('the handshake carried the account\'s authorization header', sockets[0]?.authorization === 'Bearer sk-fixture-openai-key-not-a-real-key', String(sockets[0]?.authorization))
  const create1 = lastCreate()
  check('the first frame is response.create with the whole input, store:false and no stream field', create1?.type === 'response.create' && create1.store === false && !('stream' in create1) && !('previous_response_id' in create1) && Array.isArray(create1.input) && (create1.input as unknown[]).length === 1, JSON.stringify(create1).slice(0, 300))
  check('the frame mirrors the HTTP body but for the transport fields', create1 !== undefined && create1.model === MODEL && Array.isArray(create1.tools) && (create1.tools as unknown[]).length === 1 && JSON.stringify(create1.include) === '["reasoning.encrypted_content"]', JSON.stringify(Object.keys(create1 ?? {})))
  check('the reply settled with its text and usage', textOf(r1.rows) === 'hello over the socket' && (replyRow(r1.rows)?.message as { usage?: { input_tokens?: number } }).usage?.input_tokens === 40 && r1.errors.length === 0, JSON.stringify(r1.rows.map(m => JSON.stringify(m.message).slice(0, 120))))
  const reply1 = replyRow(r1.rows)!
  const second = [...first, reply1, createUserMessage({ content: 'and again' })]
  turns = [{ text: 'again over the socket' }]
  const r2 = await call(second)
  const create2 = lastCreate()
  check('the second turn rides the SAME socket', sockets.length === 1 && posts.length === 1 && sockets[0]!.frames.length === 2, `sockets=${sockets.length} frames=${sockets[0]?.frames.length}`)
  check('…chained on the previous response with only the new user item', create2?.previous_response_id === sockets[0]!.responseIds[0] && Array.isArray(create2.input) && (create2.input as unknown[]).length === 1 && JSON.stringify(create2.input).includes('and again'), JSON.stringify(create2).slice(0, 300))
  check('the second reply settled', textOf(r2.rows) === 'again over the socket' && r2.errors.length === 0)
  const reply2 = replyRow(r2.rows)!
  turns = [{ call: { id: 'call_ls', name: 'Bash', args: '{"command":"ls"}' } }]
  const third = [...second, reply2, createUserMessage({ content: 'list the folder' })]
  const r3 = await call(third)
  const toolUse = replyRow(r3.rows)
  const toolBlock = ((toolUse?.message as { content?: Array<Record<string, unknown>> }).content ?? []).find(b => b.type === 'tool_use')
  check('a tool call settles over the socket as a tool_use block', toolBlock?.name === 'Bash' && JSON.stringify(toolBlock?.input) === '{"command":"ls"}', JSON.stringify(toolUse?.message).slice(0, 200))
  const toolResult = { type: 'user', uuid: '00000000-0000-4000-a000-000000000777', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolBlock?.id, content: 'file-a\nfile-b' }] } }
  turns = [{ text: 'two files' }]
  const r4 = await call([...third, toolUse, toolResult])
  const create4 = lastCreate()
  check('the tool round sends only the function_call_output against the previous response', create4?.previous_response_id === sockets[0]!.responseIds[2] && Array.isArray(create4.input) && (create4.input as Array<Record<string, unknown>>).length === 1 && (create4.input as Array<Record<string, unknown>>)[0]?.type === 'function_call_output' && (create4.input as Array<Record<string, unknown>>)[0]?.call_id === 'call_ls', JSON.stringify(create4).slice(0, 300))
  check('the answer after the tool round settled', textOf(r4.rows) === 'two files' && r4.errors.length === 0)
  check('four generations, four socket frames, still one HTTP post (the control)', generations === 5 && sockets[0]!.frames.length === 4 && posts.length === 1, `generations=${generations} frames=${sockets[0]?.frames.length} posts=${posts.length}`)
  const ledger = socketRoad.openaiSocketRoadLedger(socketRoad.socketRoadKey(`${base}/v1`, { authorization: 'Bearer sk-fixture-openai-key-not-a-real-key' }, 'conversation-a'))
  check('the road\'s ledger: one socket opened, three chained turns, nothing fell back', ledger.opened === 1 && ledger.chained === 3 && ledger.fellBack === 0, JSON.stringify(ledger))
  turns = [{ text: 'another conversation' }]
  await call([createUserMessage({ content: 'hello from b' })], 'conversation-b')
  check('another conversation opens its own socket', sockets.length === 2 && sockets[1]!.frames.length === 1 && !('previous_response_id' in (sockets[1]!.frames[0] ?? {})), `sockets=${sockets.length}`)
}

section('S3 the fallbacks')
{
  socketRoad._resetOpenaiSocketRoadForTest()
  const socketsBefore = sockets.length
  const postsBefore = posts.length
  const generationsBefore = generations
  mode = 'refuse-upgrade'
  turns = [{ text: 'served over http after the refused handshake' }]
  const r = await call([createUserMessage({ content: 'hello' })], 'conversation-c')
  check('a refused handshake: the request rides HTTP once, nothing generated twice', textOf(r.rows) === 'served over http after the refused handshake' && posts.length === postsBefore + 1 && sockets.length === socketsBefore && generations === generationsBefore + 1 && r.errors.length === 0, `posts=${posts.length - postsBefore} generations=${generations - generationsBefore}`)
  mode = 'error-before'
  turns = [{ text: 'served over http after the error frame' }]
  const r2 = await call([createUserMessage({ content: 'hello' })], 'conversation-d')
  check('an error frame before the response: the request rides HTTP once', textOf(r2.rows) === 'served over http after the error frame' && posts.length === postsBefore + 2 && generations === generationsBefore + 2 && r2.errors.length === 0 && sockets.at(-1)?.closed === true, `posts=${posts.length - postsBefore} generations=${generations - generationsBefore}`)
  mode = 'close-before'
  turns = [{ text: 'served over http after the close' }]
  const r3 = await call([createUserMessage({ content: 'hello' })], 'conversation-e')
  check('a close (1009, message too large) before the response: the request rides HTTP once', textOf(r3.rows) === 'served over http after the close' && posts.length === postsBefore + 3 && generations === generationsBefore + 3 && r3.errors.length === 0, `posts=${posts.length - postsBefore}`)
  mode = 'serve'
  turns = [{ text: 'first on f' }]
  const first = [createUserMessage({ content: 'hello f' })]
  const rf1 = await call(first, 'conversation-f')
  mode = 'not-found-once'
  notFoundAnswered = false
  turns = [{ text: 'second on f after the whole replay' }]
  const rf2 = await call([...first, replyRow(rf1.rows)!, createUserMessage({ content: 'again f' })], 'conversation-f')
  const fFrames = sockets.at(-1)!.frames.filter(f => f.type === 'response.create')
  check('a lost connection cache (previous_response_not_found): the whole input is sent again on the same socket, no HTTP', textOf(rf2.rows) === 'second on f after the whole replay' && fFrames.length === 3 && typeof fFrames[1]?.previous_response_id === 'string' && !('previous_response_id' in (fFrames[2] ?? {})) && (fFrames[2]?.input as unknown[]).length === 3 && posts.length === postsBefore + 3, `frames=${fFrames.length} posts=${posts.length - postsBefore}`)
  mode = 'close-mid'
  turns = [{ text: 'cut mid-way' }]
  const generationsMid = generations
  const rg = await call([createUserMessage({ content: 'hello g' })], 'conversation-g')
  check('a fault after the response began: the stream fault stands, no second generation over any road', rg.errors.length === 1 && generations === generationsMid + 1 && posts.length === postsBefore + 3, `errors=${rg.errors.length} generations=${generations - generationsMid} posts=${posts.length - postsBefore}`)
  check('…and the fault names the cut, not a bare failure', JSON.stringify(rg.errors[0]?.message).includes('closed') || JSON.stringify(rg.errors[0]?.message).includes('ended'), JSON.stringify(rg.errors[0]?.message).slice(0, 200))
  mode = 'serve'
}

section('S4 the connection\'s life and the register')
{
  socketRoad._resetOpenaiSocketRoadForTest()
  mode = 'serve'
  const socketsBefore = sockets.length
  const first = [createUserMessage({ content: 'hello h' })]
  turns = [{ text: 'first on h' }]
  const rh1 = await call(first, 'conversation-h')
  check('a conversation opens one socket', sockets.length === socketsBefore + 1 && textOf(rh1.rows) === 'first on h')
  socketRoad._ageOpenaiSocketsForTest(socketRoad.SOCKET_ROTATION_MS)
  turns = [{ text: 'second on h on a fresh socket' }]
  const rh2 = await call([...first, replyRow(rh1.rows)!, createUserMessage({ content: 'again h' })], 'conversation-h')
  const fresh = sockets.at(-1)!
  check('past the rotation age the socket is replaced and the whole input sent again (no previous_response_id)', sockets.length === socketsBefore + 2 && sockets[socketsBefore]!.closed === true && fresh.frames.length === 1 && !('previous_response_id' in (fresh.frames[0] ?? {})) && (fresh.frames[0]?.input as unknown[]).length === 3 && textOf(rh2.rows) === 'second on h on a fresh socket', `sockets=${sockets.length - socketsBefore} frames=${fresh.frames.length} ${JSON.stringify(fresh.frames[0]).slice(0, 300)}`)
  turns = [{ text: 'third on h chained again' }]
  const rh3 = await call([...first, replyRow(rh1.rows)!, createUserMessage({ content: 'again h' }), replyRow(rh2.rows)!, createUserMessage({ content: 'once more h' })], 'conversation-h')
  check('the fresh socket chains from its own first response', sockets.length === socketsBefore + 2 && fresh.frames.length === 2 && fresh.frames[1]?.previous_response_id === fresh.responseIds[0] && (fresh.frames[1]?.input as unknown[]).length === 1 && textOf(rh3.rows) === 'third on h chained again', JSON.stringify(fresh.frames[1]).slice(0, 300))
  check('the constants: connect 15 s, rotation 55 min, idle close 30 min, rest after 3 faults', socketRoad.SOCKET_CONNECT_TIMEOUT_MS === 15_000 && socketRoad.SOCKET_ROTATION_MS === 55 * 60_000 && socketRoad.SOCKET_IDLE_CLOSE_MS === 30 * 60_000 && socketRoad.SOCKET_FAULTS_BEFORE_REST === 3)
  check('the socket url is the responses path on the wss scheme', socketRoad.responsesSocketUrl('https://api.openai.com/v1') === 'wss://api.openai.com/v1/responses' && socketRoad.responsesSocketUrl(`${base}/v1`) === `ws://127.0.0.1:${server.port}/v1/responses`)
  const tail = socketRoad.incrementalInput([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] }] as never, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b' }] }] as never)
  check('the incremental input is the items after the held prefix; a changed prefix means the whole input', tail?.length === 1 && socketRoad.incrementalInput([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }] as never, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b' }] }] as never) === null && socketRoad.incrementalInput(null, [] as never) === null)
  const callModel = readFileSync(join(import.meta.dir, '..', '..', 'src/services/providers/openai/openaiCallModel.ts'), 'utf8')
  check('source pin: only the API-key account takes the socket road (the subscription backend keeps HTTP)', callModel.includes("auth.account.kind === 'api-key' && openaiSocketRoadChosen()"))
  const schema = readFileSync(join(import.meta.dir, '..', 'settings', 'settings-schema.json'), 'utf8')
  const docs = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'SETTINGS.md'), 'utf8')
  check('the setting is in the schema snapshot and the settings page', schema.includes('"websocket"') && docs.includes('`routing.openai.transport`'))
}

section('refusals — garbage frames, a cache that never answers, a changed prefix, a junk setting, the token, the record the road keeps')
{
  socketRoad._resetOpenaiSocketRoadForTest()
  const postsBefore = posts.length
  const generationsBefore = generations
  mode = 'garbage-mid'
  turns = [{ text: 'garbage after the start' }]
  const rg = await call([createUserMessage({ content: 'hello i' })], 'conversation-i')
  for (let i = 0; i < 100 && sockets.at(-1)?.closed !== true; i++) await new Promise(resolve => setTimeout(resolve, 10))
  check('a frame that is not JSON after the response began: a typed fault, the socket dropped, no second generation', rg.errors.length === 1 && JSON.stringify(rg.errors[0]?.message).includes('unparseable') && generations === generationsBefore + 1 && posts.length === postsBefore && sockets.at(-1)?.closed === true, JSON.stringify(rg.errors[0]?.message).slice(0, 200))
  mode = 'error-shape'
  turns = [{ text: 'served over http after a malformed error frame' }]
  const re = await call([createUserMessage({ content: 'hello j' })], 'conversation-j')
  check('an error frame whose error is not an object: HTTP once, nothing thrown', textOf(re.rows) === 'served over http after a malformed error frame' && posts.length === postsBefore + 1 && re.errors.length === 0, `posts=${posts.length - postsBefore}`)
  mode = 'serve'
  turns = [{ text: 'first on k' }]
  const firstK = [createUserMessage({ content: 'hello k' })]
  const rk1 = await call(firstK, 'conversation-k')
  mode = 'not-found-always'
  turns = [{ text: 'k served over http in the end' }]
  const generationsK = generations
  const rk2 = await call([...firstK, replyRow(rk1.rows)!, createUserMessage({ content: 'again k' })], 'conversation-k')
  const kFrames = sockets.at(-1)!.frames.filter(f => f.type === 'response.create')
  check('a cache that answers not-found even to the whole input: one whole replay on the socket, then HTTP — never a loop, one generation', textOf(rk2.rows) === 'k served over http in the end' && kFrames.length === 3 && !('previous_response_id' in (kFrames[2] ?? {})) && posts.length === postsBefore + 2 && generations === generationsK + 1, `frames=${kFrames.length} posts=${posts.length - postsBefore} generations=${generations - generationsK}`)
  mode = 'serve'
  socketRoad._resetOpenaiSocketRoadForTest()
  turns = [{ text: 'first on l' }]
  const firstL = [createUserMessage({ content: 'hello l' })]
  const rl1 = await call(firstL, 'conversation-l')
  turns = [{ text: 'second on l' }]
  const edited = [createUserMessage({ content: 'hello l, edited' }), replyRow(rl1.rows)!, createUserMessage({ content: 'again l' })]
  await call(edited, 'conversation-l')
  const lFrames = sockets.at(-1)!.frames.filter(f => f.type === 'response.create')
  check('an earlier item changed (a pruned or rewritten row): the whole input goes, never a chain on a context the service does not hold', lFrames.length === 2 && !('previous_response_id' in (lFrames[1] ?? {})) && (lFrames[1]?.input as unknown[]).length === 3, JSON.stringify(lFrames[1]).slice(0, 200))
  check('a junk setting value reads as off', socketRoad.openaiSocketRoadChosen({ routing: { openai: { transport: 'tcp' } } } as never) === false && socketRoad.openaiSocketRoadChosen({} as never) === false)
  const key = socketRoad.socketRoadKey(`${base}/v1`, { authorization: 'Bearer sk-fixture-openai-key-not-a-real-key' }, 'conversation-a')
  check('the connection key never carries the token', !key.includes('sk-fixture') && !key.includes('Bearer'), key)
  const reply = replyRow(rl1.rows) as { apexProviderTurn?: { provider?: string; items?: unknown[]; responseId?: string } } | undefined
  check('the road keeps the same replay record the HTTP road keeps (provider, the settled items, the response id)', reply?.apexProviderTurn?.provider === 'openai' && (reply.apexProviderTurn.items?.length ?? 0) === 1 && typeof reply.apexProviderTurn.responseId === 'string', JSON.stringify(reply?.apexProviderTurn).slice(0, 200))
  setTransport(undefined)
  turns = [{ text: 'the control over http' }]
  const socketsBefore = sockets.length
  const postsBeforeControl = posts.length
  const rc = await call([createUserMessage({ content: 'hello m' })], 'conversation-m')
  check('the control: with the setting absent again the request posts over HTTP and no socket opens', textOf(rc.rows) === 'the control over http' && sockets.length === socketsBefore && posts.length === postsBeforeControl + 1)
}

server.stop(true)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
