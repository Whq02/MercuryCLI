#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import type { DOMElement } from '../../src/ink/dom.js'
import { startFixtureApi, type FixtureApi } from '../lib/fixtureApi.ts'
import { hostRunner } from '../lib/runnerHost.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'usage-session-tally-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_HOME = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_OPERATOR = 'sam'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const name of ['ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_USAGE_SEED', 'MERCURY_MOCK_LIMITS', 'MERCURY_USAGE_POLL_MS', 'MERCURY_MODEL', 'MERCURY_ADVISOR_MODEL', 'MERCURY_CONSOLE_MODEL', 'NODE_ENV', 'CI']) {
  delete process.env[name]
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.OPENAI_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1/oauth'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1/backend-api/codex'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1/v1'
const localeString = Date.prototype.toLocaleString
Date.prototype.toLocaleString = function (_locales, options) { return localeString.call(this, 'en-US', { ...options, timeZone: 'UTC' }) }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
const settle = (ms = 100): Promise<void> => new Promise(r => setTimeout(r, ms))
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

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
const usageOwner = await import('../../src/services/providers/providerUsage.ts')
const wire = await import('../../src/services/engine-connector/seatWire.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { Usage, SESSION_SPEND_LABEL, SESSION_SPEND_NONE, sessionSpendLines } = await import('../../src/components/Settings/Usage.js')
const { Box, render, flushPendingSyncWork, EventEmitter } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
type UsageFacts = import('../../src/services/engine-connector/types.ts').UsageFactsV1
type SpendRow = import('../../src/services/engine-connector/types.ts').ModelSpendRowV1
type Connector = import('../../src/services/engine-connector/types.ts').EngineConnectorV1

const FABLE = 'claude-fable-5-1'
const ASTRA = 'gpt-6-astra'
const STRANGER = 'nobody-knows-this-model-9'
const row = (model: string, inputTokens: number, outputTokens: number, costUSD: number, extra: Partial<SpendRow> = {}): SpendRow => ({
  model,
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD,
  unpricedTurns: 0,
  ...extra,
})
const ROWS: SpendRow[] = [
  row(FABLE, 1500, 60, 0.5, { cacheReadInputTokens: 300, cacheCreationInputTokens: 90 }),
  row(ASTRA, 700, 30, 0.2),
  row(STRANGER, 40, 5, 0, { unpricedTurns: 2 }),
  row(FABLE, 100, 10, 0.01, { workload: 'cron' }),
  row(FABLE, 90, 14, 0.004, { workload: 'advisor' }),
]
const zeroUsage = (): UsageFacts => ({
  totalCostUSD: 0,
  totalAPIDurationMs: 0,
  totalDurationMs: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadInputTokens: 0,
  totalCacheCreationInputTokens: 0,
  hasUnknownModelCost: false,
})
const factsWith = (modelSpend?: SpendRow[]): UsageFacts => ({ ...zeroUsage(), ...(modelSpend === undefined ? {} : { modelSpend }) })
function focus(usage: UsageFacts): void {
  const overrides: Record<string, unknown> = { usage: () => usage }
  const connector = new Proxy(noSessionConnector(), {
    get(target, key) {
      if (typeof key === 'string' && key in overrides) return overrides[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Connector
  setFocusedSessionConnector(connector)
}

section('§1 the laws stand in the source: the slot reads the focused session\'s facts, the runner answers its per-model ledger, the bar and the rail keep their totals')
{
  const usage = read('src/components/Settings/Usage.tsx')
  check("the slot's session line is the focused session's facts partitioned by family, never the screen's own ledger", usage.includes('sessionSpendOfFacts(getFocusedSessionConnector().usage(), route)') && !usage.includes('getModelUsage('))
  check("the line's words are the old ones: 'This session' and 'This session: 0 tokens.'", SESSION_SPEND_LABEL === 'This session' && SESSION_SPEND_NONE === 'This session: 0 tokens.')
  check('an inactive slot still says it is not the billing source; the workload labels keep their words', usage.includes("INACTIVE_SLOT_LINE = 'not the active billing source this session'") && usage.includes('if (!active) return <Text dimColor>{INACTIVE_SLOT_LINE}</Text>') && usage.includes("SCHEDULED_SPEND_LABEL = 'Scheduled'") && usage.includes("ADVISOR_SPEND_LABEL = 'Advisor'"))
  const run = read('src/cli/run.ts')
  const answer = run.slice(run.indexOf("'session/facts': async () => {"), run.indexOf('identity:', run.indexOf("'session/facts': async () => {")))
  check('the runner answers its per-model ledger beside the totals (modelSpend from the ledger it holds)', answer.includes('modelSpend: sessionModelSpendRows(),') && answer.includes('unpricedTurns: getTotalUnpricedTurns(),') && answer.includes('totalCostUSD: getTotalCostUSD(),') && answer.includes('totalInputTokens: getTotalInputTokens(),'))
  const types = read('src/services/engine-connector/types.ts')
  check('the facts carry the rows: model, workload, the four token counts, the cost, the unpriced turns', types.includes('modelSpend?: ModelSpendRowV1[]') && ['model: string', 'workload?: string', 'inputTokens: number', 'cacheCreationInputTokens: number', 'costUSD: number', 'unpricedTurns: number'].every(f => types.includes(f)))
  const frame = read('src/components/MercuryFrame.tsx')
  const rail = read('src/components/HelmLanesRail.tsx')
  check("the frame's spend is the focused session's usage facts", frame.includes('const usageFacts = getFocusedSessionConnector().usage()') && frame.includes('const cost = usageFacts.totalCostUSD') && !frame.includes('getTotalCostUSD()'))
  check("the lanes rail's glance spend is the focused session's usage facts", rail.includes('const focusedUsage = getFocusedSessionConnector().usage()') && rail.includes('const focusedSpendUSD = focusedUsage.totalCostUSD') && !rail.includes('getTotalCostUSD()'))
  const words = JSON.parse(read('scripts/settings/usage-popup-words.json')) as Record<string, string[]>
  check('the recorded popup words (no session focused) carry no session tally', Object.values(words).every(runs => runs.every(run => !run.startsWith('This session'))))
}

section('§2 the wire: the rows ride the facts answer in the feed\'s spelling and read back whole')
{
  const base = { model: { effective: FABLE, setting: null }, usage: factsWith(ROWS), identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], permissionMode: 'default', workspace: { cwd: '/tmp', originalCwd: '/tmp', projectRoot: '/tmp' }, queue: [] }
  const onWire = wire.sessionFactsToWire(base as never) as { usage: { model_spend?: Array<Record<string, unknown>>; modelSpend?: unknown } }
  const first = onWire.usage.model_spend?.[0] ?? {}
  check('the answer spells model_spend rows with snake keys', Array.isArray(onWire.usage.model_spend) && onWire.usage.modelSpend === undefined && first.model === FABLE && first.input_tokens === 1500 && first.cache_read_input_tokens === 300 && first.cache_creation_input_tokens === 90 && first.cost_usd === 0.5 && first.unpriced_turns === 0 && !('inputTokens' in first), j(first))
  check('a workload row names its workload', (onWire.usage.model_spend ?? []).some(r => r.workload === 'cron' && r.model === FABLE && r.input_tokens === 100))
  const back = wire.sessionFactsFromWire(onWire)
  check('the seat reads the rows back whole', back !== null && j(back.usage.modelSpend) === j(ROWS), j(back?.usage.modelSpend?.[0]))
  const older = wire.sessionFactsFromWire(wire.sessionFactsToWire({ ...base, usage: zeroUsage() } as never))
  check('an answer without the rows (an older runner) reads back without them', older !== null && older.usage.modelSpend === undefined)
}

section('§3 the partition: every turn under the model that answered it, split by family, unpriced turns shown as such')
{
  const anthropic = usageOwner.sessionSpendOfFacts(factsWith(ROWS), 'anthropic')
  check('the Anthropic column holds the fable turns only: 1,890 input (uncached + cache read + cache write) · 60 output · $0.50 · one model', anthropic !== null && anthropic.inputTokens === 1890 && anthropic.outputTokens === 60 && Math.abs(anthropic.costUSD - 0.5) < 1e-9 && anthropic.models === 1 && anthropic.pricing === undefined, j(anthropic))
  check('its scheduled share is the cron row, its advisor share the advisor row', anthropic?.scheduled?.inputTokens === 100 && anthropic?.scheduled?.outputTokens === 10 && anthropic?.advisor?.inputTokens === 90 && anthropic?.advisor?.outputTokens === 14, j(anthropic))
  const openai = usageOwner.sessionSpendOfFacts(factsWith(ROWS), 'openai')
  check('the OpenAI column holds the astra turn only, no workload shares', openai !== null && openai.inputTokens === 700 && openai.outputTokens === 30 && Math.abs(openai.costUSD - 0.2) < 1e-9 && openai.models === 1 && openai.scheduled === undefined && openai.advisor === undefined, j(openai))
  const stranger = usageOwner.sessionSpendOfFacts(factsWith(ROWS), 'unrecognised')
  check('a model no family declares lands in the stranger bucket with its unpriced turns counted', stranger !== null && stranger.inputTokens === 40 && stranger.models === 1 && stranger.pricing?.unpricedTurns === 2 && stranger.pricing?.unpricedModels === 1, j(stranger))
  check("a family the session never ran on reads as zero models (the slot says 'This session: 0 tokens.')", usageOwner.sessionSpendOfFacts(factsWith(ROWS), 'gemini')?.models === 0)
  check('facts without the rows partition to nothing (an older runner: no line, never a false zero)', usageOwner.sessionSpendOfFacts(factsWith(undefined), 'anthropic') === null)
  state.resetCostState()
  const screen = usageOwner.providerSessionSpend('anthropic')
  focus(factsWith(ROWS))
  const lines = sessionSpendLines('anthropic', screen, true)
  check("the slot's lines: the session line first, then Scheduled and Advisor, from the facts (the screen's own ledger is empty)", lines.length === 3 && lines[0] === 'This session: 1,890 input · 60 output tokens · $0.5000' && lines[1]!.startsWith('Scheduled: 100 input · 10 output tokens') && lines[2]!.startsWith('Advisor: 90 input · 14 output tokens'), j(lines))
  check('the unpriced bucket spells its turns beside the figure, never $0.00', sessionSpendLines('unrecognised' as never, screen, true)[0]!.includes('unpriced'), j(sessionSpendLines('unrecognised' as never, screen, true)))
  focus(factsWith([]))
  check("a session with no turns yet says 'This session: 0 tokens.'", j(sessionSpendLines('anthropic', screen, true)) === j([SESSION_SPEND_NONE]))
  focus(factsWith(undefined))
  check('an older runner\'s facts give no session line at all', j(sessionSpendLines('anthropic', screen, true)) === j([]))
  releaseFocusedSessionConnector()
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
const linesOf = (frame: string): string[] => {
  const lines: string[] = []
  for (const raw of frame.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('$') && lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]} ${line}`
    else lines.push(line)
  }
  return lines
}

section("§4 THE POPUP, rendered from source with a focused session: the API-key slots paint 'This session: …' per family from the session's facts (red on the base: no line)")
{
  state.resetCostState()
  focus(factsWith(ROWS))
  let token = 60
  {
    const popup = await mountPopup(178, 51, 146, 22, token++)
    const frame = popup.frame()
    popup.close()
    const flat = frame.replace(/\s+/g, ' ')
    check("178x51: the Anthropic key slot paints the session's Anthropic figure, 1,890 input · 60 output tokens", frame.includes('This session: 1,890 input · 60 output tokens'), frame.split('\n').filter(line => line.includes('This session')).join(' | ').slice(0, 300))
    check("178x51: the OpenAI key slot paints its own family's figure, 700 input · 30 output tokens, never the Anthropic one", frame.includes('This session: 700 input · 30 output tokens') && (flat.match(/This session:/g) ?? []).length === 2, frame.split('\n').filter(line => line.includes('This session')).join(' | ').slice(0, 300))
    check('178x51: the Scheduled and Advisor shares paint beneath the Anthropic session line', frame.includes('Scheduled: 100 input · 10 output tokens') && frame.includes('Advisor: 90 input · 14 output tokens'), frame.split('\n').filter(line => line.includes('Scheduled') || line.includes('Advisor')).join(' | ').slice(0, 300))
  }
  {
    const popup = await mountPopup(80, 21, 76, 14, token++)
    const lines = linesOf(popup.frame())
    popup.close()
    const anthropic = lines.findIndex(line => line.startsWith('This session: 1,890 input · 60 output tokens'))
    const scheduled = lines.findIndex(line => line.startsWith('Scheduled: 100 input · 10 output tokens'))
    const advisor = lines.findIndex(line => line.startsWith('Advisor: 90 input · 14 output tokens'))
    check('80x21 (one column): the session line first, Scheduled beneath it, Advisor beneath that', anthropic >= 0 && scheduled === anthropic + 1 && advisor === anthropic + 2, lines.filter(line => line.startsWith('This session') || line.startsWith('Scheduled') || line.startsWith('Advisor')).join(' | ') || lines.slice(0, 30).join(' | '))
  }
  focus(factsWith(undefined))
  const popup = await mountPopup(178, 51, 146, 22, token++)
  const bare = popup.frame()
  popup.close()
  check("with a runner that answers no rows the slots paint no session line and no false zero", !bare.includes('This session'), bare.slice(0, 200))
  releaseFocusedSessionConnector()
}

section('§5 THE RUNNER: a real runner on the built bundle answers its per-model rows after a turn')
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  const nodeBin = Bun.which('node')
  const fixtures: FixtureApi[] = []
  if (nodeBin === null) check('node on PATH for the runner leg', false)
  else {
    const fx = await startFixtureApi([{ kind: 'text', text: 'TALLY-TURN-DONE.', usage: { input_tokens: 123, output_tokens: 45 } }])
    fixtures.push(fx)
    const home = mkdtempSync(join(tmpdir(), 'usage-tally-runner-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'usage-tally-runner-cwd-'))
    mkdirSync(join(home, '.mercury'), { recursive: true })
    const env: Record<string, string> = {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: fx.url,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREWS_DIR: join(home, 'crews'),
    }
    let outcome = (): void => {}
    const settled = new Promise<void>(resolve => { outcome = resolve })
    const host = hostRunner({ node: nodeBin, dist: DIST, argv: [], cwd, env, home, onRow: r => { if (r.type === 'outcome') outcome() } })
    host.onAsk(params => (params.kind === 'tool' ? { outcome: 'allow', input: params.input } : { outcome: 'allow' }))
    const killer = setTimeout(() => host.child.kill('SIGKILL'), 120_000)
    try {
      await host.initialize()
      void host.prompt('say the tally word').catch(() => undefined)
      await Promise.race([settled, settle(60_000)])
      const facts = (await host.request('session/facts', {} as never)) as { model?: { effective?: string }; usage?: { model_spend?: Array<Record<string, unknown>>; total_input_tokens?: number } }
      const rows = facts.usage?.model_spend ?? []
      const own = rows.find(r => r.workload === undefined)
      check('the facts answer carries model_spend rows', Array.isArray(facts.usage?.model_spend) && rows.length === 1, j(facts.usage?.model_spend))
      check("the session's turn sits under the model that answered it (the wire's model id), with the turn's own tokens, priced", own !== undefined && typeof own.model === 'string' && own.model.startsWith('claude-') && own.input_tokens === 123 && own.output_tokens === 45 && own.unpriced_turns === 0 && typeof own.cost_usd === 'number' && own.cost_usd > 0, j(own ?? rows))
      check('the row totals agree with the totals the bar reads', own !== undefined && facts.usage?.total_input_tokens === own.input_tokens, j({ total: facts.usage?.total_input_tokens, own: own?.input_tokens }))
      const decoded = wire.sessionFactsFromWire(facts)
      check('the seat decodes the rows into the facts the slot partitions: the Anthropic column reads the turn', decoded !== null && decoded.usage.modelSpend?.[0]?.model === own?.model && usageOwner.sessionSpendOfFacts(decoded.usage, 'anthropic')?.inputTokens === 123 && usageOwner.sessionSpendOfFacts(decoded.usage, 'openai')?.models === 0, j(decoded?.usage.modelSpend))
    } finally {
      clearTimeout(killer)
      host.end()
      await host.stop(5_000)
      for (const f of fixtures) await f.close()
    }
  }
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-usage-session-tally — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
