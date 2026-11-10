#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  console.log('\nTIMEOUT — the seat-then-fold prover exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

delete process.env.NODE_ENV
for (const ambient of ['ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_CONCOURSE_WORKER', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL']) delete process.env[ambient]
const HOME = mkdtempSync(join(tmpdir(), 'seat-then-fold-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'seat-then-fold-daemon-'))
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
const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', chunk => {
    raw += String(chunk)
  })
  req.on('end', () => {
    const url = req.url ?? ''
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    if (url === '/api/tags') return json(res, 200, { models: [{ name: LOCAL, model: LOCAL, size: 17741872134, details: { family: 'qwen35', parameter_size: '27.3B', quantization_level: 'Q4_K_M' } }] })
    if (url === '/api/version') return json(res, 200, { version: '0.40.5' })
    if (url === '/api/ps') return json(res, 200, { models: [] })
    if (url === '/api/show') return json(res, 200, { parameters: 'temperature                    1\nnum_ctx                        32768', model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 }, capabilities: ['completion', 'tools', 'thinking'] })
    if (url === '/api/generate') return json(res, 200, { model: body.model, response: '', done: true, done_reason: 'load' })
    if (url === '/api/chat') {
      chats.push({ numCtx: (body.options as { num_ctx?: number } | undefined)?.num_ctx, bytes: raw.length })
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'the local model carries on' }, done: false }) + '\n')
      res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: Math.round(raw.length / 4), eval_count: 6 }) + '\n')
      res.end()
      return
    }
    json(res, 404, { error: 'not found' })
  })
})
await new Promise<void>(done => ollama.listen(0, '127.0.0.1', () => done()))
const address = ollama.address()
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`

const { startOverflowFixture } = await import('../compact/overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

console.log('============================================================')
console.log(' the switch to a smaller window: the seat first, then the fold')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const transition = await import('../../src/utils/model/modelTransition.ts')
const seatThenFold = (transition as Partial<typeof transition>).seatThenFold
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const auto = await import('../../src/services/compact/autoCompact.ts')
const preview = await import('../../src/services/providers/transitionPreview.ts')
const { buildPostCompactMessages } = await import('../../src/services/compact/compact.ts')
const { estimateContextTokens } = await import('../../src/services/compact/microCompact.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { call } = await import('../../src/commands/compact/compact.ts')
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
await refreshLocalDiscovery({ force: true })
const fmt = (n: number): string => n.toLocaleString('en-US')

section('1 the order has one owner: on a daemon-hosted session /compact is sent only once the seat reports applied; in-process the command is parked, then the seat applies in the same tick')
{
  check('modelTransition exports seatThenFold', typeof seatThenFold === 'function')
  if (typeof seatThenFold === 'function') {
    const events: string[] = []
    const session = (carrier: 'in-process' | 'daemon') => ({ carrier, sendWords: async (text: string): Promise<void> => void events.push(`send ${text}`) })
    const park = (command: string): void => void events.push(`park ${command}`)
    let report: ((state: 'applied' | 'queued' | 'no-op' | 'refused') => void) | undefined
    seatThenFold(session('daemon'), settled => {
      events.push('seat')
      report = settled
    }, park)
    check('daemon: the seat is asked first and nothing is sent while its receipt is out (red on the parent: /compact was sent first and the seat applied afterwards)', events.join(' · ') === 'seat' && report !== undefined, events.join(' · '))
    report?.('applied')
    check('daemon: once the seat reports applied, /compact is sent once — the fold is sized by the incoming seat', events.join(' · ') === 'seat · send /compact', events.join(' · '))
    for (const state of ['queued', 'no-op', 'refused'] as const) {
      events.length = 0
      seatThenFold(session('daemon'), settled => {
        events.push('seat')
        settled?.(state)
      }, park)
      check(`daemon: a seat that reports ${state} sends no /compact${state === 'queued' ? ' — the switch lands at the turn boundary and the first turn on the new seat folds by that seat\'s own fold line' : ''}`, events.join(' · ') === 'seat', events.join(' · '))
    }
    events.length = 0
    seatThenFold(session('daemon'), () => void events.push('seat'), park)
    check('daemon: a seat that never reports folds nothing', events.join(' · ') === 'seat', events.join(' · '))
    events.length = 0
    let handed: unknown = 'unset'
    seatThenFold(session('in-process'), settled => {
      events.push('seat')
      handed = settled
    }, park)
    check('in-process: /compact is parked, then the seat applies with nothing to wait for — the parked command runs on the new seat', events.join(' · ') === 'park /compact · seat' && handed === undefined, events.join(' · '))
  }
  const cards = ['src/commands/model/model.tsx', 'src/commands/model/mercuryModel.tsx', 'src/components/PromptInput/useComposerModelDoors.tsx'].map(file => ({ file, text: readFileSync(join(import.meta.dir, '../..', file), 'utf8') }))
  for (const card of cards) {
    check(`${card.file}: the preview card hands the fold to seatThenFold, reports the seat's receipt to it, and sends no /compact of its own`, card.text.includes('seatThenFold(getFocusedSessionConnector(), seated =>') && card.text.includes('seated?.(receipt.state)') && !card.text.includes("sendWords('/compact')") && !card.text.includes("requestCommandDispatch('/compact')"))
    const reportAt = card.text.indexOf('seated?.(receipt.state)')
    const before = card.text.slice(0, Math.max(0, reportAt))
    const restoreAt = Math.max(before.lastIndexOf('choice.restore()'), before.lastIndexOf('choice?.restore()'))
    const refusedAt = before.lastIndexOf("receipt.state === 'refused'", restoreAt)
    check(`${card.file}: a refused switch restores the saved choice in its refused arm, ahead of the report of the seat's receipt`, reportAt >= 0 && refusedAt >= 0 && restoreAt > refusedAt && restoreAt - refusedAt < 60, `refused=${refusedAt} restore=${restoreAt} report=${reportAt}`)
  }
}

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
async function foldSeatedOn(seat: string): Promise<{ landed: number; post: unknown[]; wire: string; outcome: string }> {
  fixture.script([{ text: 'SUMMARY BY OPUS: the five modules were read and the design note was written; the operator asks to carry on from the note on the local model.' }, { text: 'never reached' }])
  const before = fixture.captured.length
  const messages = seed()
  let outcome: string
  let post: unknown[] = []
  try {
    const result = (await call('', makeCtx(seat, messages) as never)) as { type: string; compactionResult?: unknown }
    outcome = result.type
    if (result.compactionResult !== undefined) post = buildPostCompactMessages(result.compactionResult as never) as unknown[]
  } catch (error) {
    outcome = `threw: ${error instanceof Error ? error.message : String(error)}`
  }
  return { landed: estimateContextTokens(post as never, TARGET), post, wire: fixture.captured.slice(before).map((hit: { dialect: string }) => hit.dialect).join('→'), outcome }
}

section("2 why the order matters: the same /compact on the same history, seated on the incoming local model and on the outgoing cloud model")
{
  const history = seed()
  const plan = preview.buildTransitionPlan({ messages: history as never, from: SOURCE, to: TARGET })
  const threshold = auto.getAutoCompactThreshold(TARGET)
  const limit = auto.getBlockingLimit(TARGET)
  check('the incoming model is the tag at its Modelfile window (32,768) and the history does not fit it, so the switch asks at the preview', auto.resolveAutoCompactWindow(TARGET).window === 32_768 && plan.window?.fits === false && plan.needsChoice === true && auto.getAutoCompactThreshold(SOURCE) > 100_000, JSON.stringify(plan.window))
  const incoming = await foldSeatedOn(TARGET)
  console.log(`  [record] seated on ${TARGET}: ${incoming.outcome} · landed ${fmt(incoming.landed)} · fold line ${fmt(threshold)} · limit ${fmt(limit)} · summary wire ${incoming.wire}`)
  check("seated on the incoming model the fold lands under that model's fold line", incoming.outcome === 'compact' && incoming.landed < threshold, `${incoming.outcome} · landed ${fmt(incoming.landed)} against ${fmt(threshold)}`)
  check('…and the summary is still written on the outgoing model\'s wire', incoming.wire === 'anthropic', incoming.wire)
  check('the same switch previewed again after that fold fits', preview.transitionWindowFact(incoming.post as never, TARGET)?.fits === true, JSON.stringify(preview.transitionWindowFact(incoming.post as never, TARGET)))
  fixture.script([{ text: 'never reached' }, { text: 'never reached' }])
  const wireBefore = fixture.captured.length
  const chatsBefore = chats.length
  const errors: string[] = []
  let terminal: Record<string, unknown> = {}
  const gen = query({ messages: [...incoming.post, createUserMessage({ content: 'go on' })] as never, systemPrompt: ['fixture system prompt'] as never, userContext: {}, systemContext: {}, canUseTool: (async () => ({ behavior: 'deny', message: 'no tools in this rig' })) as never, toolUseContext: makeCtx(TARGET, incoming.post) as never, querySource: 'sdk' as never, deps: productionDeps() })
  let step = await gen.next()
  while (!step.done) {
    const row = step.value as { type?: string; isApiErrorMessage?: boolean }
    if (row.type === 'assistant' && row.isApiErrorMessage === true) errors.push(JSON.stringify(row).slice(0, 200))
    step = await gen.next()
  }
  terminal = step.value as Record<string, unknown>
  check('the first turn on the incoming model goes out as one local request: no second fold on the cloud wire, no refusal', terminal.reason === 'completed' && fixture.captured.length === wireBefore && chats.length === chatsBefore + 1 && chats.at(-1)?.numCtx === 32_768 && errors.length === 0, JSON.stringify({ terminal, cloud: fixture.captured.length - wireBefore, local: chats.length - chatsBefore, errors }))
  const outgoing = await foldSeatedOn(SOURCE)
  console.log(`  [record] seated on ${SOURCE}: ${outgoing.outcome} · landed ${fmt(outgoing.landed)} by the estimate for the incoming model`)
  check("seated on the outgoing model — what the daemon road did — the fold is sized for that model's 200k window and lands above the incoming model's limit", outgoing.outcome === 'compact' && outgoing.landed >= limit && preview.transitionWindowFact(outgoing.post as never, TARGET)?.fits === false, `${outgoing.outcome} · landed ${fmt(outgoing.landed)} against ${fmt(limit)}`)
}

await fixture.close()
ollama.close()
rmSync(HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
