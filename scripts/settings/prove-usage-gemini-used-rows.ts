#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'usage-gemini-used-rows-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_HOME = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_)/.test(name)) delete process.env[name]
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 5))

const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const state = await import('../../src/boot/process-state/processState.ts')
const { addToTotalSessionCost } = await import('../../src/models/usage/sessionCost.ts')
const { sessionModelSpendRows } = await import('../../src/engine/connector/modelSpendFacts.ts')
const wire = await import('../../src/engine/connector/seatWire.ts')
const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.ts')
const { geminiLaneModelsByLastUse, geminiPlanQuotaUnreportedWords, geminiPlanQuotaView } = await import('../../src/models/roads/gemini/geminiPlanQuota.ts')
const { sessionSpendByModel } = await import('../../src/models/roads/providerUsage.ts')
type UsageFacts = import('../../src/engine/connector/types.ts').UsageFactsV1
type Connector = import('../../src/engine/connector/types.ts').EngineConnectorV1
type Figure = import('../../src/models/roads/providerUsage.ts').UsageFigureView

const FABLE = 'claude-fable-5-1'
const ARGON = 'gemini-4-argon-high'
const FLASH = 'gemini-3.8-flash'
const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
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
function focus(facts: UsageFacts): void {
  const overrides: Record<string, unknown> = { usage: () => facts }
  const connector = new Proxy(noSessionConnector(), {
    get(target, key) {
      if (typeof key === 'string' && key in overrides) return overrides[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Connector
  setFocusedSessionConnector(connector)
}
const RESET = Date.parse('2026-10-15T00:00:00Z')
const quotaFigure = (row: string, left: number): Figure => ({ key: `plan-quota:${row}`, label: `${row} quota left`, value: `${left}%`, observedAtMs: 1_800_000_000_000, resetsAtMs: RESET, source: 'endpoint', freshForMs: 300_000 })
const FIGURES: Figure[] = [
  { key: 'plan-tier', label: 'tier Google reports', value: 'Google AI Pro', observedAtMs: 1_800_000_000_000, source: 'endpoint', freshForMs: 86_400_000 },
  quotaFigure('gemini-4-argon-low', 91),
  quotaFigure(ARGON, 42),
  quotaFigure('gemini-3.8-flash-high', 77),
  quotaFigure('google/claude-opus-4-6-thinking', 99),
  ...Array.from({ length: 23 }, (_, i) => quotaFigure(`gemini-5-row${i + 1}-high`, 99 - i)),
]

section("§1 a hosted session: the runner's ledger holds a Fable session whose crewmate spent on Argon; the face spends nothing of its own")
state.resetCostState()
addToTotalSessionCost(0.31, usage(1_200, 80), FABLE)
await tick()
addToTotalSessionCost(0, usage(142_000_000, 900_000), ARGON)
await tick()
addToTotalSessionCost(0, usage(5_000, 200), FLASH)
const runnerRows = sessionModelSpendRows()
check("the runner's rows carry the session's model and the two gemini-lane models its crewmates used", j(runnerRows.map(r => r.model)) === j([FABLE, ARGON, FLASH]), `${j(runnerRows.map(r => r.model))}; change sessionModelSpendRows in src/engine/connector/modelSpendFacts.ts so it returns one row per model the session spent on, in first-spend order`)
check('every row carries when the model was last used, later rows later', runnerRows.every(r => typeof r.lastUsedAtMs === 'number') && (runnerRows[1]!.lastUsedAtMs ?? 0) > (runnerRows[0]!.lastUsedAtMs ?? 0) && (runnerRows[2]!.lastUsedAtMs ?? 0) > (runnerRows[1]!.lastUsedAtMs ?? 0), `${j(runnerRows.map(r => r.lastUsedAtMs))}; sessionModelSpendRows in src/engine/connector/modelSpendFacts.ts must copy each model record lastUsedAtMs onto its row`)
const answer = { model: { effective: FABLE, setting: null }, usage: { ...zeroUsage(), modelSpend: runnerRows }, identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], permissionMode: 'default', workspace: { cwd: '/tmp', originalCwd: '/tmp', projectRoot: '/tmp' }, queue: [] }
const onWire = wire.sessionFactsToWire(answer as never) as { usage: { model_spend?: Array<Record<string, unknown>> } }
check('the stamp rides the wire in the feed\'s spelling', (onWire.usage.model_spend ?? []).every(r => typeof r.last_used_at_ms === 'number' && !('lastUsedAtMs' in r)), `${j(onWire.usage.model_spend?.[1])}; sessionFactsToWire in src/engine/connector/seatWire.ts must write last_used_at_ms for each model_spend row`)
const back = wire.sessionFactsFromWire(onWire)
check('the seat reads the rows back whole, the stamp included', back !== null && j(back.usage.modelSpend) === j(runnerRows), `${j(back?.usage.modelSpend?.[1])}; sessionFactsFromWire in src/engine/connector/seatWire.ts must read last_used_at_ms back into lastUsedAtMs`)
state.resetCostState()
check("the face's own ledger is empty — a hosted session's face spends nothing", Object.keys(state.getModelUsage()).length === 0, `the face ledger still holds ${j(Object.keys(state.getModelUsage()))} after state.resetCostState() in src/boot/process-state/processState.ts`)
focus(back!.usage)
const totals = sessionSpendByModel(back!.usage, 'gemini').map(entry => entry.model)
check('the token totals on the same section name the Argon model (the owner\'s 142M input tokens)', j(totals) === j([ARGON, FLASH]) && sessionSpendByModel(back!.usage, 'gemini').find(e => e.model === ARGON)?.spend.inputTokens === 142_000_000, `${j(totals)}; check sessionSpendByModel in src/models/roads/provider-usage/spend.ts against the focused connector usage rows`)
const used = geminiLaneModelsByLastUse()
check("the slot's used models come from the same facts, last use first — the crewmate's Argon row among them, the Fable row left out", j(used) === j([FLASH, ARGON]), `${j(used)}; geminiLaneModelsByLastUse in src/models/roads/gemini/geminiPlanQuota.ts must read the focused session facts and keep gemini models only, last use first`)
const view = geminiPlanQuotaView(FIGURES, { model: FABLE, effort: 'max', usedModels: used })
check("under the tier: no active row (a Fable session), the two used rows with their quota and reset, 25 folded — never '27 other roster models' over a session that spent on Argon", view.active === undefined && j(view.used.map(f => [f.key, f.value, f.resetsAtMs])) === j([['plan-quota:gemini-3.8-flash-high', '77%', RESET], [`plan-quota:${ARGON}`, '42%', RESET]]) && view.others.length === 25, `${j({ active: view.active?.key, used: view.used.map(f => f.key), others: view.others.length })}; geminiPlanQuotaView in src/models/roads/gemini/geminiPlanQuota.ts must list the used models with quota and fold the rest into others`)

section('§1b Google reports quota for some models and none for one: the used model Google does not report says so in one phrase instead of vanishing (F36A-14)')
{
  const partial = FIGURES.filter(figure => figure.key !== 'plan-quota:gemini-3.8-flash-high')
  const partialView = geminiPlanQuotaView(partial, { model: FABLE, effort: 'max', usedModels: used })
  check('the Argon row keeps its quota and reset; the Flash row is not silently dropped — it is named as unreported', j(partialView.used.map(f => f.key)) === j([`plan-quota:${ARGON}`]) && j(partialView.unreported) === j([{ model: FLASH, active: false }]), `${j({ used: partialView.used.map(f => f.key), unreported: partialView.unreported })}; geminiPlanQuotaView in src/models/roads/gemini/geminiPlanQuota.ts must put a used model with no quota figure into unreported`)
  check('the one phrase', geminiPlanQuotaUnreportedWords(FLASH) === 'gemini-3.8-flash: no quota reported for this model', geminiPlanQuotaUnreportedWords(FLASH))
  check('the full roster reports nothing as unreported', j(view.unreported) === j([]), j(view.unreported))
  const argonSession = geminiPlanQuotaView(partial, { model: FLASH, effort: 'high', usedModels: [ARGON] })
  check("the session's own model, when Google reports no quota for it, is named as unreported and marked as the session's", argonSession.active === undefined && j(argonSession.unreported) === j([{ model: FLASH, active: true }]), j(argonSession.unreported))
  const noRoster = geminiPlanQuotaView([FIGURES[0]!], { model: FLASH, effort: 'high', usedModels: [ARGON, FLASH] })
  check('with no quota rows at all nothing is unreported (the section carries the reader note for that)', j(noRoster.unreported) === j([]) && noRoster.used.length === 0, j(noRoster))
  const fable = geminiPlanQuotaView(partial, { model: FABLE, effort: 'max', usedModels: [] })
  check("a Fable session's own model is not a Gemini row and is never named", j(fable.unreported) === j([]), j(fable.unreported))
}

section('§2 an older runner publishes no rows: the slot falls to the face\'s own ledger, as the totals do')
focus(zeroUsage())
state.resetCostState()
addToTotalSessionCost(0, usage(10, 1), 'gemini-4-argon')
check('with no rows on the facts the face\'s own ledger serves', j(geminiLaneModelsByLastUse()) === j(['gemini-4-argon']), `${j(geminiLaneModelsByLastUse())}; geminiLaneModelsByLastUse in src/models/roads/gemini/geminiPlanQuota.ts must fall back to the face ledger when the focused facts carry no model rows`)

section('§3 no chat open: the plain world\'s own ledger, in last-use order, the other lanes\' models left out')
releaseFocusedSessionConnector()
state.resetCostState()
addToTotalSessionCost(0, usage(10, 1), 'claude-opus-4-8')
await tick()
addToTotalSessionCost(0, usage(10, 1), FLASH)
await tick()
addToTotalSessionCost(0, usage(10, 1), 'google/claude-opus-4-6-thinking')
await tick()
addToTotalSessionCost(0, usage(10, 1), 'gemini-4-argon')
check('the gemini-lane models come in order of last use', j(geminiLaneModelsByLastUse()) === j(['gemini-4-argon', 'google/claude-opus-4-6-thinking', FLASH]), `${j(geminiLaneModelsByLastUse())}; geminiLaneModelsByLastUse in src/models/roads/gemini/geminiPlanQuota.ts must sort the ledger by lastUsedAtMs, newest first, and drop non-gemini-lane models`)
const seeded = { 'claude-opus-4-8': { lastUsedAtMs: 50 }, [FLASH]: { lastUsedAtMs: 30 }, 'google/claude-opus-4-6-thinking': { lastUsedAtMs: 20 }, 'gemini-4-argon': { lastUsedAtMs: 10 } }
check('a ledger handed in reads as before', j(geminiLaneModelsByLastUse(seeded)) === j([FLASH, 'google/claude-opus-4-6-thinking', 'gemini-4-argon']), `${j(geminiLaneModelsByLastUse(seeded))}; geminiLaneModelsByLastUse in src/models/roads/gemini/geminiPlanQuota.ts must use the ledger argument it is handed`)
state.resetCostState()

section('§4 Gemini plan quota meter: used % matches Anthropic/xAI direction, and unknown is never 0% or 100%')
{
  const planQuotaMod = await import('../../src/models/roads/gemini/geminiPlanQuota.ts') as Record<string, unknown>
  const meterOf = planQuotaMod.geminiPlanQuotaMeter as ((figure: Figure) => { title: string; window: { usedPct?: number; resetsAtMs?: number; source?: string } } | null) | undefined
  check('geminiPlanQuotaMeter is exported for Gemini usage rows', typeof meterOf === 'function', 'export geminiPlanQuotaMeter from src/models/roads/gemini/geminiPlanQuota.ts')
  if (typeof meterOf === 'function') {
    const fullLeft = meterOf(quotaFigure('gemini-4-neon-xhigh', 100))
    check('100% left maps to 0% used with stripped title and preserved reset', fullLeft !== null && fullLeft.title === 'gemini-4-neon-xhigh' && fullLeft.window.usedPct === 0 && fullLeft.window.resetsAtMs === RESET, j(fullLeft))
    const partialLeft = meterOf(quotaFigure('gemini-4-neon-xhigh', 79))
    check('79% left maps to 21% used (same used/left direction as Anthropic & xAI)', partialLeft !== null && partialLeft.window.usedPct === 21, j(partialLeft))
    const spent = meterOf(quotaFigure('gemini-4-neon-xhigh', 0))
    check('0% left maps to 100% used', spent !== null && spent.window.usedPct === 100, j(spent))
    for (const bad of ['', 'unknown', 'n/a', 'NaN%', '-5%', '120%']) {
      const none = meterOf({ key: 'plan-quota:gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh) quota left', value: bad, observedAtMs: 1_800_000_000_000, source: 'endpoint', freshForMs: 300_000 })
      check(`unknown or invalid value ${JSON.stringify(bad)} draws no meter (never 0% or 100%)`, none === null, j(none))
    }
  }
  const { fetchGeminiPlanRoster } = await import('../../src/models/roads/gemini/geminiPlanAccess.ts')
  const { geminiPlanRosterModels } = await import('../../src/models/roads/gemini/geminiCatalogue.ts')
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === '/v1internal:fetchAvailableModels') {
        return Response.json({
          models: {
            'gemini-4-neon-xhigh': { displayName: 'Gemini 4 Neon (XHigh)', quotaInfo: { remainingFraction: 1, resetTime: '2026-10-15T00:00:00Z' } },
            'gemini-4-carbon-high': { displayName: 'Gemini 4 Carbon (High)', quotaInfo: { remainingFraction: 0.79, resetTime: '2026-10-15T00:00:00Z' } },
            'gemini-4-absent-high': { displayName: 'Gemini 4 Absent', quotaInfo: { resetTime: '2026-10-15T00:00:00Z' } },
            'gemini-4-null-high': { displayName: 'Gemini 4 Null', quotaInfo: { remainingFraction: null, resetTime: '2026-10-15T00:00:00Z' } },
            'gemini-4-string-high': { displayName: 'Gemini 4 String', quotaInfo: { remainingFraction: '80', resetTime: '2026-10-15T00:00:00Z' } },
          },
          imageGenerationModelIds: [],
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  try {
    const roster = await fetchGeminiPlanRoster({
      accessToken: 'fixture-token',
      env: { ...process.env, MERCURY_ANTIGRAVITY_CODE_ASSIST_BASE: `http://127.0.0.1:${server.port}` },
    })
    const liveModels = geminiPlanRosterModels(roster)
    const builtFigures: Figure[] = liveModels.flatMap(model => {
      if (!model.quota || model.quota.remainingFraction === undefined) return []
      return [{
        key: `plan-quota:${model.id}`,
        label: `${model.displayName ?? model.id} quota left`,
        value: `${Math.round(model.quota.remainingFraction * 100)}%`,
        observedAtMs: roster.fetchedAtMs,
        ...(model.quota.resetTime !== undefined ? { resetsAtMs: Date.parse(model.quota.resetTime) } : {}),
        source: 'endpoint',
        freshForMs: 300_000,
      }]
    })
    const keys = builtFigures.map(f => f.key)
    check('loopback fetchAvailableModels omits models whose remainingFraction is absent, null, or string (never invents 0% or 100%)', j(keys) === j(['plan-quota:gemini-4-neon-xhigh', 'plan-quota:gemini-4-carbon-high']), `${j(keys)}; fetchGeminiPlanRoster in src/models/roads/gemini/geminiPlanAccess.ts must keep a quota only when remainingFraction is a number`)
    const liveView = geminiPlanQuotaView(builtFigures, {
      model: 'gemini-4-neon',
      effort: 'xhigh',
      usedModels: ['gemini-4-carbon-high', 'gemini-4-absent-high', 'gemini-4-null-high', 'gemini-4-string-high'],
    })
    check('unreported models (absent/null/string remainingFraction) are listed as unreported with no meter', j(liveView.unreported.map(u => u.model)) === j(['gemini-4-absent-high', 'gemini-4-null-high', 'gemini-4-string-high']), `${j(liveView.unreported)}; geminiPlanQuotaView in src/models/roads/gemini/geminiPlanQuota.ts must list every used model without a quota figure as unreported`)
    const neonMeter = typeof meterOf === 'function' && liveView.active ? meterOf(liveView.active) : null
    const carbonMeter = typeof meterOf === 'function' && liveView.used[0] ? meterOf(liveView.used[0]) : null
    check('loopback model answering remainingFraction=1 draws 0% used; remainingFraction=0.79 draws 21% used', neonMeter?.window.usedPct === 0 && carbonMeter?.window.usedPct === 21, j({ neonMeter, carbonMeter }))
  } finally {
    server.stop(true)
  }
}


console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-usage-gemini-used-rows (${failures} failure${failures === 1 ? '' : 's'})`)
process.exit(failures === 0 ? 0 : 1)
