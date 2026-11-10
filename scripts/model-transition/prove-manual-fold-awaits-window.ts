#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the manual-fold window prover exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

delete process.env.NODE_ENV
for (const ambient of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_SM_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_CONCOURSE_WORKER', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_HOME']) delete process.env[ambient]
const HOME = mkdtempSync(join(tmpdir(), 'manual-fold-window-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR)
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'

const LOCAL = 'qwen3.8-27b-32k:latest'
const TARGET = `local/${LOCAL}`
const SOURCE = 'claude-opus-4-8'
const chats: Array<{ numCtx: unknown; bytes: number }> = []
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
let serving: 'up' | 'refusing' | 'silent' = 'refusing'
const stalled: ServerResponse[] = []
const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', chunk => {
    raw += String(chunk)
  })
  req.on('end', () => {
    const url = req.url ?? ''
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    if (serving === 'silent') return void stalled.push(res)
    if (serving === 'refusing') return json(res, 503, { error: 'the fixture server is not serving' })
    if (url === '/api/tags') return json(res, 200, { models: [{ name: LOCAL, model: LOCAL, size: 17741872134, details: { family: 'qwen35', parameter_size: '27.3B', quantization_level: 'Q4_K_M' } }] })
    if (url === '/api/version') return json(res, 200, { version: '0.40.5' })
    if (url === '/api/ps') return json(res, 200, { models: [] })
    if (url === '/api/show') return json(res, 200, { parameters: 'temperature                    1\nnum_ctx                        32768', model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 }, capabilities: ['completion', 'tools', 'thinking'] })
    if (url === '/api/generate') return json(res, 200, { model: body.model, response: '', done: true, done_reason: 'load' })
    if (url === '/api/chat') {
      chats.push({ numCtx: (body.options as { num_ctx?: number } | undefined)?.num_ctx, bytes: raw.length })
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'SUMMARY BY THE LOCAL MODEL' }, done: false }) + '\n')
      res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: Math.round(raw.length / 4), eval_count: 6 }) + '\n')
      res.end()
      return
    }
    json(res, 404, { error: 'not found' })
  })
})
await new Promise<void>(done => ollama.listen(0, '127.0.0.1', () => done()))
const address = ollama.address()

const { startOverflowFixture } = await import('../compact/overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
delete process.env.MERCURY_LOCAL_BASE_URL
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`

console.log('============================================================')
console.log(" the manual fold reads its seat's window from the window's own source before it sizes itself")
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const auto = await import('../../src/services/compact/autoCompact.ts')
const { buildPostCompactMessages } = await import('../../src/services/compact/compact.ts')
const { estimateContextTokens } = await import('../../src/services/compact/microCompact.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { __resetLocalWindowsForTest } = await import('../../src/services/providers/local/localWindow.ts')
const { call: compactCall } = await import('../../src/commands/compact/compact.ts')
const fmt = (n: number): string => n.toLocaleString('en-US')

const WORK = join(HOME, 'project')
mkdirSync(WORK, { recursive: true })
const bodies = new Map<string, string>()
for (let i = 1; i <= 5; i++) {
  const path = join(WORK, `module-${i}.ts`)
  const body = Array.from({ length: 700 }, (_, line) => `export const row${i}_${line} = 'module ${i} keeps record ${line} honest and bounded';`).join('\n') + '\n'
  writeFileSync(path, body)
  bodies.set(path, body)
}
function readsOfTheHistory(): ReturnType<typeof createFileStateCacheWithSizeLimit> {
  const cache = createFileStateCacheWithSizeLimit(100)
  let age = bodies.size
  for (const [path, content] of bodies) cache.set(path, { content, timestamp: Date.now() - age-- * 1000, offset: undefined, limit: undefined })
  return cache
}
function seed(): unknown[] {
  const rows: unknown[] = [createUserMessage({ content: 'read the five modules and write the design note' })]
  let n = 0
  for (const [path, content] of bodies) {
    n++
    rows.push({
      type: 'assistant', uuid: `00000000-0000-4000-a000-0000000000${10 + n}`, timestamp: new Date().toISOString(), requestId: `req_read_${n}`,
      message: { id: `msg_read_${n}`, type: 'message', role: 'assistant', model: SOURCE, content: [{ type: 'tool_use', id: `toolu_read_${n}`, name: 'Read', input: { file_path: path } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 2_000 + n * 9_000, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    })
    rows.push({ type: 'user', uuid: `00000000-0000-4000-a000-0000000000${20 + n}`, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_read_${n}`, content }] }, toolUseResult: { type: 'text', file: { filePath: path, content, numLines: 700, startLine: 1, totalLines: 700 } } })
  }
  const note = 'The note walks the module boundaries, the ports, the records and the checks that keep them honest. '.repeat(240)
  rows.push({
    type: 'assistant', uuid: '00000000-0000-4000-a000-000000000031', timestamp: new Date().toISOString(), requestId: 'req_note',
    message: { id: 'msg_note', type: 'message', role: 'assistant', model: SOURCE, content: [{ type: 'text', text: note }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 52_000, output_tokens: Math.round(note.length / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  })
  rows.push(createUserMessage({ content: 'carry on from the note on the local model' }))
  return rows
}
function makeCtx(model: string, messages: unknown[]): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>) }
  return {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: model, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages,
    readFileState: readsOfTheHistory(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}
type Folded = { landed: number; wire: string; outcome: string; tookMs: number; localChats: number }
async function foldSeatedOn(seat: string): Promise<Folded> {
  fixture.script([{ text: 'SUMMARY BY OPUS: the five modules were read and the design note was written; the operator asks to carry on from the note on the local model.' }, { text: 'never reached' }])
  const before = fixture.captured.length
  const chatsBefore = chats.length
  const startedAt = Date.now()
  let outcome: string
  let post: unknown[] = []
  try {
    const result = (await compactCall('', makeCtx(seat, seed()) as never)) as { type: string; compactionResult?: unknown }
    outcome = result.type
    if (result.compactionResult !== undefined) post = buildPostCompactMessages(result.compactionResult as never) as unknown[]
  } catch (error) {
    outcome = `threw: ${error instanceof Error ? error.message : String(error)}`
  }
  return { landed: estimateContextTokens(post as never, TARGET), wire: fixture.captured.slice(before).map((hit: { dialect: string }) => hit.dialect).join('→'), outcome, tookMs: Date.now() - startedAt, localChats: chats.length - chatsBefore }
}
const say = (label: string, folded: Folded): void => console.log(`  [record] ${label}: ${folded.outcome.slice(0, 260)} · landed ${fmt(folded.landed)} · summary wire ${folded.wire === '' ? 'none' : folded.wire} · local chat requests ${folded.localChats} · ${fmt(folded.tookMs)} ms`)

section('1 the runner has not read the local server when the fold starts: the server came up after the runner looked')
{
  await refreshLocalDiscovery({ force: true })
  serving = 'up'
  check("the runner's snapshot holds no record of the tag, so the seat's window reads as the 200,000 fallback", localRecordFor(TARGET) === undefined && auto.resolveAutoCompactWindow(TARGET).window === 200_000, JSON.stringify(auto.resolveAutoCompactWindow(TARGET)))
  const folded = await foldSeatedOn(TARGET)
  say(`seated on ${TARGET}`, folded)
  const record = localRecordFor(TARGET)
  const window = auto.resolveAutoCompactWindow(TARGET).window
  const foldLine = auto.getAutoCompactThreshold(TARGET)
  check('the fold read the server before it sized itself: the tag is known at its Modelfile window of 32,768', record !== undefined && window === 32_768, `record ${String(record !== undefined)} window ${window}`)
  check("the fold landed under the tag's own fold line (red on the parent: sized on the 200,000 fallback, the local model was picked to write the summary and its request was refused)", folded.outcome === 'compact' && folded.landed > 0 && folded.landed < foldLine, `${folded.outcome.slice(0, 200)} · landed ${fmt(folded.landed)} against ${fmt(foldLine)}`)
  check("the summary was written on the outgoing model's wire and nothing was asked of the local server", folded.wire === 'anthropic' && folded.localChats === 0, `wire ${folded.wire} · local ${folded.localChats}`)
}

section('2 the outgoing model cannot write the summary: the seated local model writes it inside its own window')
{
  const kept = process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_AUTH_TOKEN
  const { clearOAuthTokenCache } = await import('../../src/utils/auth.ts')
  clearOAuthTokenCache()
  const { usabilityForRoute } = await import('../../src/services/providers/providerUsability.ts')
  const signedOut = usabilityForRoute('anthropic').usable === false
  const chatsBefore = chats.length
  const folded = await foldSeatedOn(TARGET)
  say(`seated on ${TARGET}, ${SOURCE} signed out`, folded)
  const asked = chats.slice(chatsBefore)
  console.log(`  [record] the local requests: ${asked.map(chat => `${fmt(Math.round(chat.bytes / 4))} tokens at num_ctx ${String(chat.numCtx)}`).join(' · ')}`)
  check('the outgoing model is signed out, so no model whose window holds the whole history can write the summary', signedOut, JSON.stringify(usabilityForRoute('anthropic')))
  check("the fold still lands under the tag's fold line: the local model wrote the summary in requests that each fit its 32,768 window, and nothing left for the cloud wire", folded.outcome === 'compact' && folded.landed > 0 && folded.landed < auto.getAutoCompactThreshold(TARGET) && folded.wire === '' && asked.length >= 1 && asked.every(chat => chat.numCtx === 32_768 && chat.bytes / 4 < 32_768), `${folded.outcome.slice(0, 300)} · landed ${fmt(folded.landed)} · wire ${folded.wire} · ${JSON.stringify(asked)}`)
  if (kept !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = kept
  clearOAuthTokenCache()
}

section('3 the local server is not there: the fold still answers, within its bound')
for (const state of ['refusing', 'silent'] as const) {
  serving = state
  await refreshLocalDiscovery({ force: true })
  __resetLocalWindowsForTest()
  const known = localRecordFor(TARGET) !== undefined
  const folded = await foldSeatedOn(TARGET)
  say(`seated on ${TARGET}, the server ${state === 'refusing' ? 'answers 503 to every read' : 'accepts and never answers'}`, folded)
  check(`the server ${state === 'refusing' ? 'refuses every read' : 'never answers'}: the tag is unknown, the fold does not hang — it answers in under 30 s with its fold or its own error`, !known && folded.tookMs < 30_000 && (folded.outcome === 'compact' || folded.outcome.startsWith('threw: ')), `known ${String(known)} · ${fmt(folded.tookMs)} ms · ${folded.outcome.slice(0, 200)}`)
  for (const held of stalled.splice(0)) held.destroy()
}

await fixture.close()
ollama.closeAllConnections?.()
ollama.close()
rmSync(HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
