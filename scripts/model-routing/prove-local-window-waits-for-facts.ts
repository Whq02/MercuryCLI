#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'local-window-waits-for-facts-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = scratch
for (const key of ['MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MODEL', 'NODE_ENV']) delete process.env[key]
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

const STATED = 'qwen3.8-27b-64k:latest'
const UNSTATED = 'qwen3.8-27b:latest'
const NUM_CTX = 65_536
const TRAINED = 262_144
let showDelayMs = 0
const shows: string[] = []
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const tag = (name: string): Record<string, unknown> => ({ name, model: name, size: 17_741_872_134, details: { family: 'qwen35', parameter_size: '27.3B', quantization_level: 'Q4_K_M' } })
const ollama = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', chunk => {
    raw += String(chunk)
  })
  req.on('end', () => {
    const url = req.url ?? ''
    if (url === '/api/tags') return json(res, 200, { models: [tag(STATED), tag(UNSTATED)] })
    if (url === '/api/version') return json(res, 200, { version: '0.40.5' })
    if (url === '/api/ps') return json(res, 200, { models: [] })
    if (url === '/api/show') {
      const model = String((JSON.parse(raw || '{}') as { model?: unknown }).model ?? '')
      shows.push(model)
      const parameters = model === STATED ? `temperature                    1\nnum_ctx                        ${NUM_CTX}` : 'temperature                    1'
      setTimeout(() => json(res, 200, { parameters, model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': TRAINED }, capabilities: ['completion', 'tools', 'thinking'], details: { family: 'qwen35' } }), showDelayMs)
      return
    }
    if (url === '/api/generate') return json(res, 200, { model: STATED, response: '', done: true, done_reason: 'load' })
    json(res, 404, { error: 'not found' })
  })
})
await new Promise<void>(done => ollama.listen(0, '127.0.0.1', () => done()))
const address = ollama.address()
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const preview = await import('../../src/services/providers/transitionPreview.ts')
const discovery = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const windows = await import('../../src/services/providers/local/localWindow.ts')
const { awaitContextWindowSource, contextWindowSourceReady } = await import('../../src/utils/model/contextWindowWarmup.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')

const note = (n: number): string => {
  let out = ''
  for (let line = 0; out.length < 40_000; line++) out += `Note ${n}, section ${line} records a module boundary: ${createHash('sha256').update(`n${n}-l${line}`).digest('hex')}. Check the indexed observations before changing it.\n`
  return out
}
const messages: unknown[] = []
for (let n = 1; n <= 6; n++) {
  messages.push(createUserMessage({ content: `write design note ${n}` }))
  messages.push(createAssistantMessage({ content: note(n) }))
}
const estTokens = tokenCountWithEstimation(messages as never)
const target = (id: string): string => `local/${id}`
const holdOf = (id: string): { window: number | undefined; reason: string } | undefined => {
  const record = localRecordFor(target(id))
  const hold = record === undefined ? undefined : windows.heldLocalWindow(record)
  return hold === undefined ? undefined : { window: hold.window, reason: hold.reason }
}
const planOf = (id: string): { needsChoice: boolean; fits: unknown; window: unknown } => {
  const plan = preview.previewForSelection(messages as never, 'claude-opus-4-8', target(id))
  return { needsChoice: plan.needsChoice, fits: (plan.window as { fits?: unknown } | undefined)?.fits, window: (plan.window as { window?: unknown } | undefined)?.window }
}
const fresh = (): void => {
  windows.__resetLocalWindowsForTest()
  shows.length = 0
}
const show = (value: unknown): string => JSON.stringify(value)

console.log(`history: ${messages.length} rows, ${estTokens.toLocaleString('en-US')} tokens by Mercury's count; the Modelfile of ${STATED} states num_ctx ${NUM_CTX.toLocaleString('en-US')}`)

section('§1 the server answers /api/show at once: the window held for the session is the Modelfile\'s num_ctx, and the switch asks')
{
  fresh()
  showDelayMs = 0
  await discovery.refreshLocalDiscovery({ force: true })
  const record = localRecordFor(target(STATED))
  check('the record carries the Modelfile\'s num_ctx and the trained maximum, and is not marked unread', record?.modelfileContext === NUM_CTX && record.modelMaxContext === TRAINED && record.factsUnread === undefined, show(record))
  const known = await awaitContextWindowSource(target(STATED), { estTokens })
  check('the hold is 65,536 by the Modelfile\'s rule', known && show(holdOf(STATED)) === show({ window: NUM_CTX, reason: 'set' }), show(holdOf(STATED)))
  check('a 60k history does not fit it: the switch needs a choice', planOf(STATED).needsChoice === true && planOf(STATED).fits === false, show(planOf(STATED)))
}

section('§2 /api/show answers slower than the discovery probe waits: the record says its facts are unread, the window source re-reads them before it holds anything, and the hold is the Modelfile\'s num_ctx')
{
  fresh()
  showDelayMs = 1_500
  await discovery.refreshLocalDiscovery({ force: true })
  const unread = localRecordFor(target(STATED))
  check('after the first discovery the tag is listed with no Modelfile facts and marked unread', unread !== undefined && unread.modelfileContext === undefined && unread.modelMaxContext === undefined && unread.factsUnread === true, show(unread))
  check('…so its window source is not ready, and nothing is held', (await contextWindowSourceReady(target(STATED))) === false && holdOf(STATED) === undefined, show(holdOf(STATED)))
  const asked = shows.filter(model => model === STATED).length
  const known = await awaitContextWindowSource(target(STATED), { estTokens })
  const read = localRecordFor(target(STATED))
  check('awaiting the source asks /api/show again and reads the facts', known && shows.filter(model => model === STATED).length === asked + 1 && read?.modelfileContext === NUM_CTX && read.factsUnread === undefined, `${shows.filter(model => model === STATED).length} asks · ${show(read)}`)
  check('the hold is the Modelfile\'s 65,536, never the doubled 131,072', show(holdOf(STATED)) === show({ window: NUM_CTX, reason: 'set' }), show(holdOf(STATED)))
  check('…and the switch needs a choice, as it does when the server answers at once', planOf(STATED).needsChoice === true && planOf(STATED).fits === false, show(planOf(STATED)))
}

section('§3 /api/show does not answer within the wait: the window is chosen from the request as before, and once a later discovery reads the Modelfile the hold is decided again and never stands above its num_ctx')
{
  fresh()
  showDelayMs = 1_500
  await discovery.refreshLocalDiscovery({ force: true })
  const known = await awaitContextWindowSource(target(STATED), { estTokens, timeoutMs: 300 })
  const first = holdOf(STATED)
  check('with the facts still unread the hold is the doubled request, 131,072', known && show(first) === show({ window: 131_072, reason: 'req' }) && localRecordFor(target(STATED))?.factsUnread === true, show(first))
  const asks = shows.length
  check('a held window is ready and is not asked about again on every check', (await contextWindowSourceReady(target(STATED))) === true && (await awaitContextWindowSource(target(STATED), { estTokens })) === true && shows.length === asks, `${shows.length - asks} more asks`)
  await new Promise(resolve => setTimeout(resolve, 1_600))
  showDelayMs = 0
  await discovery.refreshLocalDiscovery({ force: true })
  check('a later discovery reads the Modelfile: the standing hold is no longer the source', localRecordFor(target(STATED))?.modelfileContext === NUM_CTX && (await contextWindowSourceReady(target(STATED))) === false, show(holdOf(STATED)))
  await awaitContextWindowSource(target(STATED), { estTokens })
  check('the next await decides again: 65,536 by the Modelfile\'s rule', show(holdOf(STATED)) === show({ window: NUM_CTX, reason: 'set' }), show(holdOf(STATED)))
}

section('§4 a tag whose Modelfile states no num_ctx keeps the window Mercury chose for the session')
{
  fresh()
  showDelayMs = 0
  await discovery.refreshLocalDiscovery({ force: true })
  await awaitContextWindowSource(target(UNSTATED), { estTokens })
  const first = holdOf(UNSTATED)
  await discovery.refreshLocalDiscovery({ force: true })
  await awaitContextWindowSource(target(UNSTATED), { estTokens })
  check('the record is read, states no num_ctx, and its hold is the same before and after another discovery', localRecordFor(target(UNSTATED))?.factsUnread === undefined && localRecordFor(target(UNSTATED))?.modelfileContext === undefined && first !== undefined && first.reason !== 'set' && show(holdOf(UNSTATED)) === show(first), `${show(first)} → ${show(holdOf(UNSTATED))}`)
}

ollama.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
