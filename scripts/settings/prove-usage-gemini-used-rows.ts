#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
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
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const state = await import('../../src/bootstrap/state.ts')
const { addToTotalSessionCost } = await import('../../src/cost-tracker.ts')
const { sessionModelSpendRows } = await import('../../src/services/engine-connector/modelSpendFacts.ts')
const wire = await import('../../src/services/engine-connector/seatWire.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { geminiLaneModelsByLastUse, geminiPlanQuotaUnreportedWords, geminiPlanQuotaView } = await import('../../src/services/providers/gemini/geminiPlanQuota.ts')
const { sessionSpendByModel } = await import('../../src/services/providers/providerUsage.ts')
type UsageFacts = import('../../src/services/engine-connector/types.ts').UsageFactsV1
type Connector = import('../../src/services/engine-connector/types.ts').EngineConnectorV1
type Figure = import('../../src/services/providers/providerUsage.ts').UsageFigureView

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
check("the runner's rows carry the session's model and the two gemini-lane models its crewmates used", j(runnerRows.map(r => r.model)) === j([FABLE, ARGON, FLASH]), j(runnerRows.map(r => r.model)))
check('every row carries when the model was last used, later rows later', runnerRows.every(r => typeof r.lastUsedAtMs === 'number') && (runnerRows[1]!.lastUsedAtMs ?? 0) > (runnerRows[0]!.lastUsedAtMs ?? 0) && (runnerRows[2]!.lastUsedAtMs ?? 0) > (runnerRows[1]!.lastUsedAtMs ?? 0), j(runnerRows.map(r => r.lastUsedAtMs)))
const answer = { model: { effective: FABLE, setting: null }, usage: { ...zeroUsage(), modelSpend: runnerRows }, identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], permissionMode: 'default', workspace: { cwd: '/tmp', originalCwd: '/tmp', projectRoot: '/tmp' }, queue: [] }
const onWire = wire.sessionFactsToWire(answer as never) as { usage: { model_spend?: Array<Record<string, unknown>> } }
check('the stamp rides the wire in the feed\'s spelling', (onWire.usage.model_spend ?? []).every(r => typeof r.last_used_at_ms === 'number' && !('lastUsedAtMs' in r)), j(onWire.usage.model_spend?.[1]))
const back = wire.sessionFactsFromWire(onWire)
check('the seat reads the rows back whole, the stamp included', back !== null && j(back.usage.modelSpend) === j(runnerRows), j(back?.usage.modelSpend?.[1]))
state.resetCostState()
check("the face's own ledger is empty — a hosted session's face spends nothing", Object.keys(state.getModelUsage()).length === 0)
focus(back!.usage)
const totals = sessionSpendByModel(back!.usage, 'gemini').map(entry => entry.model)
check('the token totals on the same section name the Argon model (the owner\'s 142M input tokens)', j(totals) === j([ARGON, FLASH]) && sessionSpendByModel(back!.usage, 'gemini').find(e => e.model === ARGON)?.spend.inputTokens === 142_000_000, j(totals))
const used = geminiLaneModelsByLastUse()
check("the slot's used models come from the same facts, last use first — the crewmate's Argon row among them, the Fable row left out", j(used) === j([FLASH, ARGON]), j(used))
const view = geminiPlanQuotaView(FIGURES, { model: FABLE, effort: 'max', usedModels: used })
check("under the tier: no active row (a Fable session), the two used rows with their quota and reset, 25 folded — never '27 other roster models' over a session that spent on Argon", view.active === undefined && j(view.used.map(f => [f.key, f.value, f.resetsAtMs])) === j([['plan-quota:gemini-3.8-flash-high', '77%', RESET], [`plan-quota:${ARGON}`, '42%', RESET]]) && view.others.length === 25, j({ active: view.active?.key, used: view.used.map(f => f.key), others: view.others.length }))

section('§1b Google reports quota for some models and none for one: the used model Google does not report says so in one phrase instead of vanishing (F36A-14)')
{
  const partial = FIGURES.filter(figure => figure.key !== 'plan-quota:gemini-3.8-flash-high')
  const partialView = geminiPlanQuotaView(partial, { model: FABLE, effort: 'max', usedModels: used })
  check('the Argon row keeps its quota and reset; the Flash row is not silently dropped — it is named as unreported', j(partialView.used.map(f => f.key)) === j([`plan-quota:${ARGON}`]) && j(partialView.unreported) === j([{ model: FLASH, active: false }]), j({ used: partialView.used.map(f => f.key), unreported: partialView.unreported }))
  check('the one phrase', geminiPlanQuotaUnreportedWords(FLASH) === 'gemini-3.8-flash: no quota reported for this model', geminiPlanQuotaUnreportedWords(FLASH))
  check('the full roster reports nothing as unreported', j(view.unreported) === j([]), j(view.unreported))
  const argonSession = geminiPlanQuotaView(partial, { model: FLASH, effort: 'high', usedModels: [ARGON] })
  check("the session's own model, when Google reports no quota for it, is named as unreported and marked as the session's", argonSession.active === undefined && j(argonSession.unreported) === j([{ model: FLASH, active: true }]), j(argonSession.unreported))
  const noRoster = geminiPlanQuotaView([FIGURES[0]!], { model: FLASH, effort: 'high', usedModels: [ARGON, FLASH] })
  check('with no quota rows at all nothing is unreported (the section carries the reader note for that)', j(noRoster.unreported) === j([]) && noRoster.used.length === 0, j(noRoster))
  const fable = geminiPlanQuotaView(partial, { model: FABLE, effort: 'max', usedModels: [] })
  check("a Fable session's own model is not a Gemini row and is never named", j(fable.unreported) === j([]), j(fable.unreported))
  const usageSource = read('src/components/Settings/Usage.tsx')
  check('the Google sign-in slot paints the unreported rows with the one phrase, beside the used rows', usageSource.includes('quota.unreported.map(') && usageSource.includes("geminiPlanQuotaUnreportedWords(entry.model)}") && usageSource.includes("entry.active ? \"the session's model\" : 'used this session'"), 'the slot does not paint quota.unreported')
  check('the compact figures line carries the same row', usageSource.includes('for (const entry of view.unreported) ordered.push({ key: `plan-quota-unreported:${entry.model}`') && usageSource.includes("value: 'no quota reported for'"), 'geminiPlanFiguresInOrder does not carry the unreported rows')
}

section('§2 an older runner publishes no rows: the slot falls to the face\'s own ledger, as the totals do')
focus(zeroUsage())
state.resetCostState()
addToTotalSessionCost(0, usage(10, 1), 'gemini-4-argon')
check('with no rows on the facts the face\'s own ledger serves', j(geminiLaneModelsByLastUse()) === j(['gemini-4-argon']), j(geminiLaneModelsByLastUse()))

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
check('the gemini-lane models come in order of last use', j(geminiLaneModelsByLastUse()) === j(['gemini-4-argon', 'google/claude-opus-4-6-thinking', FLASH]), j(geminiLaneModelsByLastUse()))
const seeded = { 'claude-opus-4-8': { lastUsedAtMs: 50 }, [FLASH]: { lastUsedAtMs: 30 }, 'google/claude-opus-4-6-thinking': { lastUsedAtMs: 20 }, 'gemini-4-argon': { lastUsedAtMs: 10 } }
check('a ledger handed in reads as before', j(geminiLaneModelsByLastUse(seeded)) === j([FLASH, 'google/claude-opus-4-6-thinking', 'gemini-4-argon']))
state.resetCostState()

section('§4 the source law: every slot surface takes the one default — the session\'s facts — never the face\'s ledger by name')
{
  const quota = read('src/services/providers/gemini/geminiPlanQuota.ts')
  check('the default source of the used models is the focused session\'s usage facts', quota.includes('getFocusedSessionConnector().usage()'))
  for (const rel of ['src/components/Settings/Usage.tsx', 'src/components/Settings/usageLine.ts', 'src/components/geminiConnectGuide.ts']) {
    const text = read(rel)
    const calls = text.match(/geminiLaneModelsByLastUse\([^)]*\)/g) ?? []
    check(`${rel} asks for the used models with the default source (${calls.length} call${calls.length === 1 ? '' : 's'})`, calls.length > 0 && calls.every(call => call === 'geminiLaneModelsByLastUse()'), j(calls))
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-usage-gemini-used-rows (${failures} failure${failures === 1 ? '' : 's'})`)
process.exit(failures === 0 ? 0 : 1)
