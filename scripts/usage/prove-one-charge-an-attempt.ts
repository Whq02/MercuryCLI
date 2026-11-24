#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'one-charge-'))
const cwd = join(scratch, 'work')
mkdirSync(cwd, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_BARE', 'NODE_ENV', 'MERCURY_PROJECT_INTEL']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const previousCwd = process.cwd()
process.chdir(cwd)

let failures = 0
let checks = 0
const HINT = 'check settleMessageDelta, startMessage and resetStreamAttempt in src/models/roads/anthropic/stream-core/streamEvents.ts'
const check = (label: string, good: boolean, detail = ''): void => {
  checks++
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}${good ? (detail ? ` — ${detail}` : '') : ` — ${[detail, HINT].filter(Boolean).join('; ')}`}`)
  if (!good) failures++
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

try {
  const state = await import('../../src/boot/process-state/processState.ts')
  state.setOriginalCwd(cwd)
  state.setProjectRoot(cwd)
  state.setCwdState(cwd)
  state.setIsInteractive(false)
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const events = await import('../../src/models/roads/anthropic/stream-core/streamEvents.ts')
  const { calculateUSDCost } = await import('../../src/models/usage/modelCost.ts')
  const { EMPTY_USAGE } = await import('../../src/engine/requests/apiCallLogging.ts')

  const MODEL = 'claude-fable-5-1'
  const ledger = (model: string) => {
    const row = state.getUsageForModel(model)
    return { input: row?.inputTokens ?? 0, output: row?.outputTokens ?? 0, read: row?.cacheReadInputTokens ?? 0, write: row?.cacheCreationInputTokens ?? 0, searches: row?.webSearchRequests ?? 0, cost: row?.costUSD ?? 0 }
  }
  const call = (): Record<string, unknown> => ({ usage: EMPTY_USAGE, ledgerSettled: false, stopReason: null, clientRequestId: undefined, partialMessage: undefined, ttftMs: 0, start: Date.now(), ledgerFirstDifference: null })
  const start = (c: Record<string, unknown>, usage: Record<string, unknown>): void => {
    events.startMessage(c as never, { type: 'message_start', message: { id: 'm', model: MODEL, usage } } as never, () => {})
  }
  const delta = (c: Record<string, unknown>, usage: Record<string, unknown>, model = MODEL): void => {
    events.settleMessageDelta(c as never, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage } as never, [], () => model, { querySource: 'probe_one_charge', model } as never, [])
  }

  console.log('§1 one attempt, two message deltas: the attempt is charged once, for its final usage')
  const a = call()
  start(a, { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 50, output_tokens: 1 })
  delta(a, { output_tokens: 40 })
  const afterFirst = ledger(MODEL)
  const firstUsage = a.usage
  check('the first delta charges as released: the whole usage', afterFirst.input === 1000 && afterFirst.output === 40 && afterFirst.read === 200 && afterFirst.write === 50, JSON.stringify(afterFirst))
  check('the first delta charges as released: its cost', near(afterFirst.cost, calculateUSDCost(MODEL, firstUsage as never)), `ledger ${afterFirst.cost} · the price of that usage ${calculateUSDCost(MODEL, firstUsage as never)}`)
  check('the first delta marks the ledger settled', a.ledgerSettled === true)
  delta(a, { output_tokens: 100, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } })
  const afterSecond = ledger(MODEL)
  check('a later delta of the same attempt adds only the tokens beyond: input 1000, output 100, cache read 200, cache write 50', afterSecond.input === 1000 && afterSecond.output === 100 && afterSecond.read === 200 && afterSecond.write === 50, JSON.stringify(afterSecond))
  check('a later delta adds a web search it reports and no more', afterSecond.searches === 1, `searches ${afterSecond.searches}`)
  check('the session cost is the price of the final usage, once', near(afterSecond.cost, calculateUSDCost(MODEL, a.usage as never)) && near(state.getTotalCostUSD(), calculateUSDCost(MODEL, a.usage as never)), `ledger ${afterSecond.cost} · total ${state.getTotalCostUSD()} · the price of the final usage ${calculateUSDCost(MODEL, a.usage as never)}`)
  delta(a, { output_tokens: 100, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } })
  const afterThird = ledger(MODEL)
  check('the same delta a third time adds nothing', JSON.stringify(afterThird) === JSON.stringify(afterSecond), JSON.stringify(afterThird))

  console.log('§2 a new attempt of the same call is a new charge')
  events.resetStreamAttempt(a as never, () => {}, [], [], new Set())
  check('the reset clears the settled mark and the usage', a.ledgerSettled === false && (a.usage as { output_tokens: number }).output_tokens === 0)
  start(a, { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 50, output_tokens: 1 })
  delta(a, { output_tokens: 30 })
  const afterRetry = ledger(MODEL)
  check('the second attempt is charged whole: input 2000, output 130', afterRetry.input === 2000 && afterRetry.output === 130 && afterRetry.read === 400 && afterRetry.write === 100, JSON.stringify(afterRetry))
  check("its cost is added to the first attempt's", near(afterRetry.cost, afterSecond.cost + calculateUSDCost(MODEL, a.usage as never)), `ledger ${afterRetry.cost}`)

  console.log('§3 a model with no price: one attempt is one unpriced turn')
  const UNPRICED = 'probe-model-with-no-price'
  const turnsBefore = state.getTotalUnpricedTurns()
  const b = call()
  start(b, { input_tokens: 10, output_tokens: 1 })
  delta(b, { output_tokens: 5 }, UNPRICED)
  const turnsAfterFirst = state.getTotalUnpricedTurns()
  delta(b, { output_tokens: 9 }, UNPRICED)
  const turnsAfterSecond = state.getTotalUnpricedTurns()
  const unpriced = ledger(UNPRICED)
  check('the first delta counts the unpriced turn', turnsAfterFirst === turnsBefore + 1, `before ${turnsBefore} · after ${turnsAfterFirst}`)
  check('a later delta of the same attempt counts no second unpriced turn', turnsAfterSecond === turnsAfterFirst, `after the second ${turnsAfterSecond}`)
  check('its tokens are counted once: input 10, output 9', unpriced.input === 10 && unpriced.output === 9, JSON.stringify(unpriced))
} finally {
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? `all ${checks} hold` : `${failures} of ${checks} fail`)
process.exit(failures === 0 ? 0 : 1)
