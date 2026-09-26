#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import type { DOMElement } from '../../src/ink/dom.js'

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'cron-billing-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_HOME = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_OPERATOR = 'sam'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_USAGE_SEED', 'MERCURY_MOCK_LIMITS', 'MERCURY_USAGE_POLL_MS', 'MERCURY_MODEL', 'NODE_ENV', 'CI']) {
  delete process.env[name]
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1/oauth'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1/backend-api/codex'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1/v1'
const localeString = Date.prototype.toLocaleString
Date.prototype.toLocaleString = function (_locales, options) { return localeString.call(this, 'en-US', { ...options, timeZone: 'UTC' }) }

const frameDir = ((): string | null => {
  const at = process.argv.indexOf('--frames')
  return at >= 0 && process.argv[at + 1] !== undefined ? resolve(process.argv[at + 1]!) : null
})()
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
type Raw = Record<string, unknown>
const settle = (ms = 100): Promise<void> => new Promise(r => setTimeout(r, ms))
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const between = (text: string, from: string, to: string): string => {
  const at = text.indexOf(from)
  if (at < 0) return ''
  const end = text.indexOf(to, at)
  return end < 0 ? text.slice(at) : text.slice(at, end + to.length)
}

async function stub(path: string, fixtureExports: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixtureExports() }))
}
await stub('../../src/services/providers/openai/openaiCatalogue.js', () => ({ getGptSeatAvailability: () => ({ state: 'ready', ids: ['fixture-model'] }) }))
await stub('../../src/services/providers/catalogueOnDemand.js', () => ({ readCatalogueIfPending: async () => undefined }))
await stub('../../src/hooks/useCatalogueEpoch.js', () => ({ useCatalogueEpoch: () => 0 }))
await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: () => undefined }))
await stub('../../src/services/providers/moonshot/moonshotAccounts.js', () => ({ resolveMoonshotAccount: () => undefined, resolveMoonshotApiKey: () => undefined }))
await stub('../../src/services/providers/huggingface/huggingfaceAccounts.js', () => ({ resolveHuggingfaceAccount: () => undefined }))
await stub('../../src/services/providers/huggingface/huggingfaceCatalogue.js', () => ({ getHuggingfaceAvailability: () => ({ state: 'absent', liveIds: [], reason: 'not connected' }) }))
await stub('../../src/services/providers/local/localDiscovery.js', () => ({ getCachedLocalDiscovery: () => undefined }))
await stub('../../src/services/providers/local/localAccounts.js', () => ({ resolveLocalAccount: () => undefined }))
await stub('../../src/components/ConfigurableShortcutHint.js', () => ({ ConfigurableShortcutHint: () => null }))

const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const state = await import('../../src/bootstrap/state.ts')
const tracker = await import('../../src/cost-tracker.ts')
const workload = await import('../../src/utils/workloadContext.ts')
const rows = await import('../../src/utils/messages/noticeRows.ts')
const driver = await import('../../src/cli/headless/turnDriver.ts')
const queue = await import('../../src/input-core/command-queue.ts')
const { requeueUndeliveredLines } = await import('../../src/cli/headless/restartCarry.ts')
const { queueLogRows } = await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { recordTranscript, recordSidechainTranscript, flushSessionStorage } = await import('../../src/utils/sessionStorage/writer.ts')
const { getTranscriptPath, getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
const { recordToEntry } = await import('../../src/fabric/entryCodec.ts')
const { calculateUSDCost, modelPricingBasis } = await import('../../src/utils/modelCost.ts')
const usageOwner = await import('../../src/services/providers/providerUsage.ts')
const costCommand = await import('../../src/commands/cost/cost.ts')
const mappers = await import('../../src/utils/messages/mappers.ts')
const schemas = await import('../../src/entrypoints/sdk/coreSchemas.ts')
const { Usage } = await import('../../src/components/Settings/Usage.js')
const { Box, Text, render, flushPendingSyncWork, EventEmitter } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')

const loose = (module: unknown): Record<string, (...args: never[]) => unknown> => module as Record<string, (...args: never[]) => unknown>
const ledger = loose(state)
const trackerLoose = loose(tracker)
const ownerLoose = loose(usageOwner)
const costLoose = loose(costCommand)
const mappersLoose = loose(mappers)
const rowsLoose = loose(rows)

const MODEL = 'claude-sonnet-4-5'
const UNPRICED_MODEL = 'a-model-with-no-rate-on-file'
const FIRED_AT = '2026-06-19T09:00:00.000Z'
const ROW_AT = '2026-06-19T09:00:04.000Z'
const REASON = 'the row-2 build is running; RUN-OK follows it'
const WAKE_TEXT = `[self-paced wake — why you woke: ${REASON}]\n\nCheck the build log, then answer with the three things that need a ruling, shortest first.`
const OPERATOR_LINE = 'take the first two as my defaults'
const wakeOrigin = (): Raw => ({ kind: 'saturn', fire: 'wake', firedAt: FIRED_AT, spelling: 'in ~900s', reason: REASON })
const cronOrigin = (): Raw => ({ kind: 'saturn', fire: 'cron', firedAt: FIRED_AT, scheduleId: '3f9a2c1d', spelling: 'Every weekday at 09:00' })
const U1 = 'a5b6c7d8-0000-4000-8000-000000000021'
const U4 = 'a5b6c7d8-0000-4000-8000-000000000024'
const usageOf = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Raw => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite })
const SCHEDULED_USAGE = usageOf(1_000, 60, 400, 100)
const OWN_USAGE = usageOf(300, 20, 0, 0)
const fold = (model: string, usage: Raw): number => {
  const cost = calculateUSDCost(model, usage as never)
  tracker.addToTotalSessionCost(cost, usage as never, model)
  return cost
}
const SIZES: Array<[number, number, number, number]> = [
  [178, 51, 146, 22],
  [80, 21, 76, 14],
]

section('§0 the census (a guard, green on both trees): the one workload, its readers, and the batch law')
{
  check("the workload vocabulary is the one word 'cron'", workload.WORKLOAD_CRON === 'cron')
  const runner = src('src/cli/print.ts')
  const reader = between(runner, 'const workload = command.workload ?? options.workload', 'await runWithWorkload(workload, async () => {')
  check("the run-time reader takes the queued command's workload first and enters the turn under it", reader.includes('command.workload ?? options.workload') && reader.includes('runWithWorkload(workload'), reader.slice(0, 200))
  const operator = { value: OPERATOR_LINE, mode: 'prompt' } as never
  const fire = { value: WAKE_TEXT, mode: 'prompt', workload: 'cron', origin: wakeOrigin() } as never
  const secondFire = { value: 'the second fire', mode: 'prompt', workload: 'cron', origin: cronOrigin() } as never
  check("the batch law: a cron fire never merges into the operator's turn, and two fires merge under the one cron workload", !driver.canBatchWith(operator, fire) && !driver.canBatchWith(fire, operator) && driver.canBatchWith(fire, secondFire))
}

section("§1 THE STAMP (red on the base): every road that queues a Saturn fire stamps the cron workload beside the origin, from one helper at the origin's home")
{
  let stamp: ((origin: unknown) => Raw) | undefined
  try {
    stamp = rowsLoose.saturnQueueStamp as (origin: unknown) => Raw
    const wake = stamp(wakeOrigin())
    const cron = stamp(cronOrigin())
    check("the stamp of a wake's origin is the origin and the cron workload, nothing else (red on the base: the helper stands nowhere)", j(wake) === j({ origin: wakeOrigin(), workload: 'cron' }) && j(cron) === j({ origin: cronOrigin(), workload: 'cron' }), j(wake))
    check('a foreign origin and no origin stamp nothing', j(stamp({ kind: 'channel', server: 'x' })) === '{}' && j(stamp(undefined)) === '{}')
  } catch (error) {
    check("the stamp helper stands at the origin's home (noticeRows.saturnQueueStamp)", false, String(error))
  }
  const runner = src('src/cli/print.ts')
  const seatless = between(runner, 'const deliverLocalWake = (', 'driver.kick()')
  check('the seatless wake road spreads the one stamp (red on the base: a literal of its own)', seatless.includes('...saturnQueueStamp(next.origin)') && !seatless.includes("workload: 'cron'"), seatless.slice(seatless.indexOf('enqueue({'), seatless.indexOf('enqueue({') + 220))
  const stdinRoad = between(runner, 'const sentAt = typeof typed.timestamp', 'driver.kick()')
  const stdinEnqueue = stdinRoad.slice(stdinRoad.indexOf('enqueue({'))
  check("the stdin road's fire spreads the one stamp beside its words (red on the base: the origin rides alone, no workload — the fire bills as the session's default)", stdinEnqueue.includes('...saturnQueueStamp(typed.origin)') && !stdinEnqueue.includes('{ origin: typed.origin }'), stdinEnqueue)
  const carry = src('src/cli/headless/restartCarry.ts')
  const requeue = between(carry, 'export function requeueUndeliveredLines', 'return requeued')
  check('the restart carry spreads the one stamp when it re-queues a journal row (red on the base: the origin alone)', requeue.includes('...saturnQueueStamp(row.origin)') && !requeue.includes('{ origin: row.origin }'), requeue.slice(requeue.indexOf('const command'), requeue.indexOf('enqueue(command)')))
}

section('§1b THE CARRY, driven: a wake re-queued from the journal after the runner died runs under the cron workload (red on the base: no workload on the carried command)')
{
  const journalLines = (): string[] => {
    const lines: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (name.endsWith('.jsonl')) lines.push(...readFileSync(path, 'utf8').split('\n'))
      }
    }
    try {
      walk(join(HOME, 'projects'))
    } catch {
      return []
    }
    return lines
  }
  queue.resetCommandQueue()
  queue.enqueue({ value: OPERATOR_LINE, mode: 'prompt', uuid: U1 as never, sentAt: ROW_AT })
  queue.enqueue({ value: WAKE_TEXT, mode: 'prompt', uuid: U4 as never, priority: 'later', sentAt: ROW_AT, origin: wakeOrigin() as never })
  await recordTranscript([createUserMessage({ content: 'a real message materializes the file' })])
  const deadline = Date.now() + 5000
  let lines: string[] = []
  while (Date.now() < deadline) {
    lines = journalLines()
    if (queueLogRows(lines).filter(row => row.operation === 'enqueue').length >= 2) break
    await settle(100)
  }
  queue.resetCommandQueue()
  requeueUndeliveredLines(lines)
  const carried = queue.getCommandQueue().map(command => ({ ...command })) as Raw[]
  queue.resetCommandQueue()
  const wake = carried.find(c => c.uuid === U4)
  const words = carried.find(c => c.uuid === U1)
  check('the journal replays both lines, the words and the wake', carried.length === 2 && wake !== undefined && words !== undefined, j(carried.map(c => c.uuid)))
  check('the re-queued wake carries its origin and the cron workload (red on the base: workload undefined)', wake !== undefined && rows.isSaturnOrigin(wake.origin) && wake.workload === 'cron', j({ origin: wake?.origin, workload: wake?.workload }))
  check("the operator's re-queued line carries no workload", words !== undefined && words.workload === undefined && words.origin === undefined, j(words))
}

section("§2 THE BUCKET (red on the base): the ledger folds a turn's spend into the workload it ran under, beside the per-model row")
state.resetCostState()
let scheduledCost = 0
let ownCost = 0
{
  scheduledCost = await workload.runWithWorkload('cron', async () => {
    await settle(1)
    return fold(MODEL, SCHEDULED_USAGE)
  })
  ownCost = fold(MODEL, OWN_USAGE)
  const byModel = state.getModelUsage()[MODEL]
  check('the per-model row carries both turns, as before', byModel !== undefined && byModel.inputTokens === 1_300 && byModel.outputTokens === 80 && byModel.cacheReadInputTokens === 400 && Math.abs(byModel.costUSD - (scheduledCost + ownCost)) < 1e-9, j(byModel))
  try {
    const bucket = (ledger.getWorkloadUsage as () => Record<string, Record<string, Raw>>)()
    const cron = bucket.cron?.[MODEL]
    check("the cron bucket carries the scheduled turn alone (red on the base: no bucket — the spend folds into the model row and nowhere else)", cron !== undefined && cron.inputTokens === 1_000 && cron.outputTokens === 60 && cron.cacheReadInputTokens === 400 && cron.cacheCreationInputTokens === 100 && Math.abs((cron.costUSD as number) - scheduledCost) < 1e-9, j(bucket))
    check('a turn outside any workload lands in no bucket', Object.keys(bucket).length === 1, j(Object.keys(bucket)))
    check('an unpriced model inside the workload is counted unpriced in the bucket, never a zero that reads as free', modelPricingBasis(UNPRICED_MODEL) === 'unpriced' && (await workload.runWithWorkload('cron', async () => {
      fold(UNPRICED_MODEL, usageOf(50, 5))
      return (ledger.getWorkloadUnpricedTurns as () => Record<string, Record<string, number>>)().cron?.[UNPRICED_MODEL] === 1
    })), j((ledger.getWorkloadUnpricedTurns as (() => unknown) | undefined)?.()))
  } catch (error) {
    check('the ledger keeps a per-workload bucket (getWorkloadUsage, getWorkloadUnpricedTurns)', false, String(error))
  }
}

section("§3 THE SURFACES (red on the base): /cost, the usage popup and the usage card each show scheduled work in its own row, beside the session's own")
{
  const spend = (ownerLoose.scheduledSessionSpend as (() => Raw) | undefined)?.()
  check("the usage owner's scheduled spend is the bucket's sum: 1,550 in (input + cache read + cache write, the operator-facing total) · 65 out, one unpriced turn beside the priced ones", spend !== undefined && spend.inputTokens === 1_550 && spend.outputTokens === 65 && spend.models === 2 && (spend.pricing as Raw | undefined)?.unpricedTurns === 1, j(spend))
  const laneLine = (costLoose.scheduledLaneLine as (() => string | null) | undefined)?.()
  check("/cost: the scheduled row in the lane grammar — 'Scheduled work: 1,550 in · 65 out — $… + 1 unpriced turn'", typeof laneLine === 'string' && laneLine.startsWith('Scheduled work: 1,550 in · 65 out — $') && laneLine.endsWith('+ 1 unpriced turn'), j(laneLine))
  const costText = String(((await costCommand.call()) as { value?: unknown }).value ?? '')
  check('/cost prints the scheduled row beside the totals (red on the base: no scheduled row at all)', laneLine !== null && laneLine !== undefined && costText.includes(laneLine) && costText.includes('Total cost:'), costText)
  const anthropic = usageOwner.providerSessionSpend('anthropic') as Raw
  const scheduled = anthropic.scheduled as Raw | undefined
  check("the popup's owner derivation: a provider's session spend carries its scheduled share (red on the base: no share on the spend)", scheduled !== undefined && scheduled.inputTokens === 1_500 && scheduled.outputTokens === 60 && scheduled.models === 1, j(anthropic))
  const cardLine = (ownerLoose.scheduledUsageLine as (() => string | null) | undefined)?.()
  check("the card's attribution line — 'scheduled 1.6k spent · $… + 1 unpriced turn'", typeof cardLine === 'string' && cardLine.startsWith('scheduled 1.6k spent · $') && cardLine.endsWith('+ 1 unpriced turn'), j(cardLine))
  const rail = src('src/components/HelmTelemetryRail.tsx')
  check('the rail paints the scheduled line under USAGE beside the crew line (red on the base: no such row)', rail.includes('scheduledUsageLine()') && rail.includes('key="usage:scheduled"'))
  const sdk = (mappersLoose.toSDKWorkloadUsage as ((usage: unknown) => Raw) | undefined)?.((ledger.getWorkloadUsage as (() => unknown) | undefined)?.())
  const cron = sdk?.cron as Raw | undefined
  check("the SDK usage frame: workload_usage.cron sums the bucket in the model_usage row shape (red on the base: no mapper)", cron !== undefined && cron.input_tokens === 1_050 && cron.output_tokens === 65 && cron.cache_read_input_tokens === 400 && cron.cache_creation_input_tokens === 100 && typeof cron.cost_usd === 'number' && Math.abs((cron.cost_usd as number) - scheduledCost) < 1e-9, j(sdk))
  const frame = { type: 'result', subtype: 'success', result: 'done', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, session_id: 's', total_cost_usd: 0.1, usage: {}, model_usage: {}, workload_usage: { cron: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 0, cost_usd: 0.1 } }, uuid: 'u' }
  const parsed = schemas.SDKResultSuccessSchema().safeParse(frame)
  check('the public result schema keeps workload_usage (red on the base: an undeclared key is stripped)', parsed.success && j((parsed.data as Raw).workload_usage) === j(frame.workload_usage), parsed.success ? j(Object.keys(parsed.data as Raw)) : j(parsed.error.issues))
  const engine = src('src/QueryEngine.ts')
  const envelope = between(engine, 'const buildResultEnvelope = ', 'permission_denials:')
  check("the engine's result envelope carries workload_usage beside model_usage", envelope.includes('model_usage: toSDKModelUsage(getModelUsage())') && envelope.includes('workload_usage: toSDKWorkloadUsage('), envelope.slice(-240))
}

async function mountPopup(columns: number, rowCount: number, width: number, rowBudget: number, openToken: number): Promise<{ frame: () => string; close: () => void }> {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: rowCount }) as unknown as NodeJS.WriteStream
  const root = React.createRef<DOMElement>()
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const tree = React.createElement(StdinContext.Provider, { value: context }, React.createElement(Box, { ref: root, flexDirection: 'column' }, React.createElement(Usage, { width, rowBudget, openToken } as never)))
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await settle(5)
  }
  return {
    frame: () => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
    close() { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}

section("§3b THE POPUP, rendered from source: the API-key slot paints 'This session: …' and, beneath it, 'Scheduled: …' (red on the base: the session line stands alone)")
const popupFrames = new Map<string, string>()
{
  let token = 40
  for (const [columns, rowCount, width, rowBudget] of SIZES) {
    const popup = await mountPopup(columns, rowCount, width, rowBudget, token++)
    const frame = popup.frame()
    popup.close()
    popupFrames.set(`${columns}x${rowCount}`, frame)
    const lines: string[] = []
    for (const raw of frame.split('\n')) {
      const line = raw.trim()
      if (line.startsWith('$') && lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]} ${line}`
      else lines.push(line)
    }
    const session = lines.findIndex(line => line.startsWith('This session: 1,800 input · 80 output tokens · $'))
    const scheduled = lines.findIndex(line => line.startsWith('Scheduled: 1,500 input · 60 output tokens'))
    check(`${columns}x${rowCount}: the session line stands, and the scheduled row stands right beneath it with the share's own figure`, session >= 0 && scheduled === session + 1 && /^Scheduled: 1,500 input · 60 output tokens · \$[0-9.]+$/.test(lines[scheduled] ?? ''), lines.filter(line => line.startsWith('This session') || line.startsWith('Scheduled')).join(' | ') || frame.slice(0, 400))
  }
}

section("§4 THE ROW AND THE REBUILD (red on the base): an assistant row written under the workload carries it, and a resumed session rebuilds the bucket from what the rows and the slot carry")
state.resetCostState()
{
  const sessionId = String(state.getSessionId())
  const transcript = getTranscriptPath()
  const assistantRow = (id: string, usage: Raw): Raw => {
    const row = createAssistantMessage({ content: `reply ${id}`, usage: usage as never }) as unknown as Raw
    return { ...row, message: { ...(row.message as Raw), id, model: MODEL } }
  }
  let inside = 0
  await workload.runWithWorkload('cron', async () => {
    await settle(1)
    inside = fold(MODEL, SCHEDULED_USAGE)
    await recordTranscript([createUserMessage({ content: WAKE_TEXT, origin: wakeOrigin() as never }) as never, assistantRow('msg_scheduled', SCHEDULED_USAGE) as never])
    await recordSidechainTranscript([createUserMessage({ content: 'the sub-agent brief' }) as never, assistantRow('msg_agent', usageOf(10, 5)) as never], 'agent-cron-1')
    inside += fold(MODEL, usageOf(10, 5))
  })
  const outside = fold(MODEL, OWN_USAGE)
  await recordTranscript([createUserMessage({ content: OPERATOR_LINE }) as never, assistantRow('msg_own', OWN_USAGE) as never])
  await flushSessionStorage()
  await settle(150)
  const decoded = (path: string): Raw[] => readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Raw).filter(record => (record.payload as Raw | undefined)?.kind === 'output').map(record => recordToEntry(record as never) as Raw)
  const mainRows = decoded(transcript)
  const scheduledRow = mainRows.find(row => (row.message as Raw).id === 'msg_scheduled')
  const ownRow = mainRows.find(row => (row.message as Raw).id === 'msg_own')
  check("the assistant row written under the workload carries it (red on the base: the row has no workload — a resume rebuild cannot bucket it)", scheduledRow !== undefined && scheduledRow.workload === 'cron' && (scheduledRow.message as Raw).model === MODEL, j({ workload: scheduledRow?.workload, keys: Object.keys(scheduledRow ?? {}) }))
  check("the operator's own reply carries none", ownRow !== undefined && ownRow.workload === undefined, j(ownRow?.workload))
  const agentRows = decoded(getAgentTranscriptPath('agent-cron-1' as never))
  check("a sub-agent's row settled inside the scheduled turn carries the workload too", agentRows.some(row => (row.message as Raw).id === 'msg_agent' && row.workload === 'cron'), j(agentRows.map(row => [(row.message as Raw).id, row.workload])))
  const counters = (record: Raw | undefined): string => j(record === undefined ? null : [record.inputTokens, record.outputTokens, record.cacheReadInputTokens, record.cacheCreationInputTokens, record.webSearchRequests, Number((record.costUSD as number).toFixed(9))])
  const liveBucket = counters((ledger.getWorkloadUsage as (() => Record<string, Record<string, Raw>>) | undefined)?.().cron?.[MODEL])
  const liveModel = counters(state.getModelUsage()[MODEL] as Raw | undefined)
  tracker.saveCurrentSessionCosts()
  state.resetCostState()
  check('the ledger is empty after the reset', Object.keys(state.getModelUsage()).length === 0)
  const restored = await (trackerLoose.restoreCostStateForSession as (id: string, path?: string) => Promise<boolean> | boolean)(sessionId, transcript)
  const bucket = (ledger.getWorkloadUsage as (() => Record<string, Record<string, Raw>>) | undefined)?.()
  const cron = bucket?.cron?.[MODEL]
  check('the resume restores the per-model ledger as before: 1,310 in · 85 out and the same cost', restored === true && counters(state.getModelUsage()[MODEL] as Raw | undefined) === liveModel && state.getModelUsage()[MODEL]?.inputTokens === 1_310, `${counters(state.getModelUsage()[MODEL] as Raw | undefined)} vs live ${liveModel}`)
  check("the resume rebuilds the cron bucket: 1,010 in · 65 out, the scheduled turn and its sub-agent's, the operator's turn outside it (red on the base: no bucket comes back)", cron !== undefined && cron.inputTokens === 1_010 && cron.outputTokens === 65 && cron.cacheReadInputTokens === 400 && Math.abs((cron.costUSD as number) - inside) < 1e-9 && counters(cron) === liveBucket && Object.keys(bucket ?? {}).length === 1, j({ bucket, inside, outside }))
}

if (frameDir !== null) {
  section(`frames → ${frameDir}`)
  mkdirSync(frameDir, { recursive: true })
  const index: string[] = ['the scheduled bucket frames — the usage popup, the usage card rows and the /cost text, rendered from source at the named size', '']
  for (const [name, frame] of popupFrames) {
    const file = `usage-popup-${name}.txt`
    writeFileSync(join(frameDir, file), `${frame}\n`)
    index.push(`${file} — the /usage popup's Anthropic API-key slot: the session line, the scheduled row beneath it`)
    console.log(`  wrote ${file}`)
  }
  const { railPanelInnerWidth } = await import('../../src/components/mercury-ui/RailPanel.js')
  const { railPlanAt } = await import('../../src/utils/helmGeometry.ts')
  const cardLine = (ownerLoose.scheduledUsageLine as (() => string | null) | undefined)?.() ?? null
  const view = usageOwner.windowSourceUsages({ model: MODEL, reads: {} }).primary
  for (const [columns, rowCount] of SIZES) {
    const rowW = railPanelInnerWidth(railPlanAt(columns, true).telemetryW)
    const children: React.ReactElement[] = [
      React.createElement(Box, { key: 'label', width: rowW }, React.createElement(Text, { wrap: 'truncate-end' }, `  ${view.label}`)),
      React.createElement(Box, { key: 'spend', width: rowW }, React.createElement(Text, { wrap: 'truncate-end' }, `  spend ${view.spend.models > 0 ? `${tracker.formatLaneSpend(view.spend)} session` : 'none yet'}`)),
    ]
    if (cardLine !== null) children.push(React.createElement(Box, { key: 'scheduled', width: rowW }, React.createElement(Text, { wrap: 'truncate-end' }, `  ${cardLine}`)))
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns, rows: rowCount }) as unknown as NodeJS.WriteStream
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
    const emitter = new EventEmitter()
    const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    let painted = (): void => {}
    const firstFrame = new Promise<void>(resolve => { painted = resolve })
    const instance = await render(React.createElement(StdinContext.Provider, { value: context }, React.createElement(Box, { flexDirection: 'column', width: rowW }, ...children)), { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
    await firstFrame
    for (let index = 0; index < 4; index++) {
      flushPendingSyncWork()
      await settle(5)
    }
    const frame = stripAnsi(instance.lastFrame()).replace(/\n$/, '')
    instance.unmount()
    instance.cleanup()
    stream.destroy()
    const file = `usage-card-${columns}x${rowCount}.txt`
    writeFileSync(join(frameDir, file), `${frame}\n`)
    index.push(`${file} — the rail's USAGE rows: the source label, the session spend, the scheduled line`)
    console.log(`  wrote ${file}`)
  }
  const costText = stripAnsi(String(((await costCommand.call()) as { value?: unknown }).value ?? ''))
  for (const [columns, rowCount] of SIZES) {
    const file = `cost-${columns}x${rowCount}.txt`
    writeFileSync(join(frameDir, file), `${costText.split('\n').map(line => line.length > columns ? line.slice(0, columns) : line).join('\n')}\n`)
    index.push(`${file} — the /cost text, the scheduled row beside the lane rows`)
    console.log(`  wrote ${file}`)
  }
  writeFileSync(join(frameDir, 'index.txt'), `${index.join('\n')}\n`)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} cron billing: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
