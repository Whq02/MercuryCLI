#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'crew-seats-home-'))
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SEATS
delete process.env.MERCURY_MODEL_LANES
delete process.env.MERCURY_RECOVERY_BUDGET_MINUTES
delete process.env.NODE_ENV

const t = checker()

const globalConfig = await import('../../src/utils/config/globalConfig.js')
globalConfig.enableConfigs()
const cap = await import('../../src/services/switchboard/capacityCheck.js')
const words = await import('../../src/services/capacity/seatWords.js')
const crew = await import('../../src/services/engine-connector/crewFacts.js')
const budget = await import('../../src/services/api/recoveryBudget.js')
const pulse = await import('../../src/tools/WorkflowTool/livePulse.js')
const manifest = await import('../../src/tools/WorkflowTool/runManifest.js')
const { saveGlobalConfig } = await import('../../src/utils/config.js')

t.section('S1 — the seat reading is stable under its own seats; the facts name the source')
{
  cap._setHeldMachineSeatReadingForTesting(null)
  const cost = cap.SEAT_COST_BYTES[cap.SEAT_COST_KIND]
  t.check('the pure ladder still falls with available memory (the disease, isolated)', cap.machineSeatReading(10, cost * 10) === 10 && cap.machineSeatReading(10, cost * 6) === 6, `${cap.machineSeatReading(10, cost * 10)} → ${cap.machineSeatReading(10, cost * 6)}`)
  cap._setHeldMachineSeatReadingForTesting(5)
  const first = cap.resolveSeatCeiling()
  const again = cap.resolveSeatCeiling()
  t.check('five seats read once stay five on the re-read (held for the process)', first === 5 && again === 5, `${first} → ${again}`)
  const machineFacts = cap.seatCeilingFacts()
  t.check("the facts name the machine as the source with the reading's own sentence", machineFacts.seats === 5 && machineFacts.source === 'machine' && machineFacts.sentence === "this machine's reading: 5 seats", JSON.stringify(machineFacts))
  t.check('the lever names the three doors and the at-once law', machineFacts.lever.includes('/seats N') && machineFacts.lever.includes('Boot Menu') && machineFacts.lever.includes('/config') && machineFacts.lever.includes('at once'), machineFacts.lever)
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.UTC(2026, 0, 2), allowed: true, recommendedSeats: 3 } }))
  const consented = cap.seatCeilingFacts()
  t.check('a consented recommendation is the ceiling as-is, named as consented and dated', consented.seats === 3 && consented.source === 'consented' && consented.sentence.startsWith('the consented capacity reading from 2026-01-02: 3 seats'), JSON.stringify(consented))
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: false } }))
  t.check('a declined probe reads the held machine reading', cap.seatCeilingFacts().source === 'machine' && cap.resolveSeatCeiling() === 5, JSON.stringify(cap.seatCeilingFacts()))
  cap._setHeldMachineSeatReadingForTesting(null)
}

t.section('S2 — the seat sentence')
{
  t.check('the seats: the width, the holders in order, the chat named', words.seatWaitWords({ width: 3, holders: ['agent-a', 'agent-b', words.CHAT_HOLDER], narrowing: null }) === 'waiting for a seat — 3 of 3 held (agent-a, agent-b, the chat)', words.seatWaitWords({ width: 3, holders: ['agent-a', 'agent-b', words.CHAT_HOLDER], narrowing: null }))
  t.check('no holders named ⇒ no parenthesis', words.seatWaitWords({ width: 2, holders: [], narrowing: null }) === 'waiting for a seat — 0 of 2 held', words.seatWaitWords({ width: 2, holders: [], narrowing: null }))
  const parts = words.seatWaitParts({ width: 3, holders: ['agent-a', 'agent-b', words.CHAT_HOLDER], narrowing: null })
  t.check('the parts: the gate and the holders, and the sentence is their join', parts.gate === 'waiting for a seat — 3 of 3 held' && parts.holders === 'agent-a, agent-b, the chat' && words.seatWaitWords({ width: 3, holders: ['agent-a', 'agent-b', words.CHAT_HOLDER], narrowing: null }) === `${parts.gate} (${parts.holders})`, JSON.stringify(parts))
  const split = words.splitWaitSentence('waiting for a seat — 3 of 3 held (agent-a, agent-b, the chat)')
  t.check('the splitter reads the published sentence back into the same parts', split.gate === parts.gate && split.holders === parts.holders, JSON.stringify(split))
  const bare = words.splitWaitSentence('waiting for a seat — 0 of 2 held')
  t.check('a sentence with no holders splits to the gate and no holders', bare.gate === 'waiting for a seat — 0 of 2 held' && bare.holders === '', JSON.stringify(bare))
  const foreign = words.splitWaitSentence('waiting for the provider')
  t.check('a sentence that is not a seat wait is all gate', foreign.gate === 'waiting for the provider' && foreign.holders === '', JSON.stringify(foreign))
  const solo = words.seatWaitWords({ width: 1, holders: ['agent-a'], narrowing: { by: 'profile', band: 1, profileId: 'openai-default' } })
  t.check('a solo profile narrowing names the profile and the band', solo === 'waiting for a lane — delegation narrowed to 1 lane by the solo profile openai-default (its delegation width, band 1) — 1 of 1 held (agent-a)', solo)
  const op = words.seatWaitWords({ width: 1, holders: ['agent-a'], narrowing: { by: 'operator', lanes: 1 } })
  t.check('the operator ceiling narrowing names the variable', op === 'waiting for a lane — delegation narrowed to 1 lane by MERCURY_MODEL_LANES=1 — 1 of 1 held (agent-a)', op)
  t.check('nothing narrows ⇒ no narrowing words', words.seatNarrowingWords(null) === null, 'null')
}

t.section('S3 — the crew facts owner carries the wait')
{
  const base = { id: 'a1', kind: 'agent' as const, name: 'tide-gauges', status: 'running', startTime: 1_000, model: 'gpt-5.6-sol' }
  const waiting = crew.crewAgentFactsOf({ ...base, wait: 'waiting for a seat — 3 of 3 held (a, b, the chat)' }, 's1')
  t.check('a waiting row reads `waiting` and spells the sentence', waiting !== null && waiting.running && crew.crewStateLabel(waiting) === 'waiting' && crew.crewWaitLine(waiting) === 'waiting for a seat — 3 of 3 held (a, b, the chat)', JSON.stringify(waiting))
  const working = crew.crewAgentFactsOf(base, 's1')
  t.check('a row without a wait reads its state and no line', working !== null && crew.crewStateLabel(working) === 'running' && crew.crewWaitLine(working) === null, JSON.stringify(working))
  const landed = crew.crewAgentFactsOf({ ...base, status: 'completed', endTime: 2_000, wait: 'stale words' }, 's1')
  t.check('a settled row never wears a wait', landed !== null && crew.crewStateLabel(landed) === 'landed' && crew.crewWaitLine(landed) === null, JSON.stringify(landed))
}

t.section('S4 — the retry budget: one budget across attempts, words that speak')
{
  const b = budget.makeRecoveryBudget(5 * 60_000)
  const one = budget.chargeRecoveryWait(b, 40_000, 429)
  t.check('a 40 s wait inside a 5m budget is honoured whole', one.honoredMs === 40_000 && one.spent === false && b.spentMs === 40_000 && b.waits === 1, JSON.stringify(one))
  const w1 = budget.retryWaitWords({ attempt: 3, of: 10, declaredMs: 40_000, honoredMs: 40_000, status: 429, budget: b })
  t.check('the words: the attempt, the seconds, the status, the budget left', w1 === 'provider throttled — retry 3 of 10 in 40 s (HTTP 429); 4m 20s of the 5m retry budget left', w1)
  const two = budget.chargeRecoveryWait(b, 600_000, 429)
  t.check('a 600 s wait past the remainder is honoured up to it and spends the budget', two.honoredMs === 260_000 && two.spent === true && budget.recoveryBudgetRemainingMs(b) === 0, JSON.stringify(two))
  const w2 = budget.retryWaitWords({ attempt: 4, of: 10, declaredMs: 600_000, honoredMs: 260_000, status: 429, budget: b })
  t.check("the words name the budget's end inside the declared wait", w2 === 'provider throttled — retry 4 of 10 in 10m (HTTP 429); the 5m retry budget ends this wait after 4m 20s', w2)
  const three = budget.chargeRecoveryWait(b, 30_000, 429)
  t.check('a spent budget honours nothing more', three.honoredMs === 0 && three.spent === true, JSON.stringify(three))
  const line = budget.recoveryBudgetSpentLine(b)
  t.check('the spent line is typed: the budget, the waits, the status, the knob', line === 'provider throttled — the 5m retry budget is spent after 3 declared waits (HTTP 429); the agent stopped — retry later, or raise MERCURY_RECOVERY_BUDGET_MINUTES', line)
  t.check('the knob: unset ⇒ 5 minutes', budget.recoveryBudgetMs() === 5 * 60_000, String(budget.recoveryBudgetMs()))
  process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '2'
  t.check('the knob: 2 ⇒ two minutes', budget.recoveryBudgetMs() === 120_000, String(budget.recoveryBudgetMs()))
  process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '0'
  const off = budget.makeRecoveryBudget()
  const whole = budget.chargeRecoveryWait(off, 3_600_000)
  t.check('the knob: 0 ⇒ the budget is off and every wait is honoured whole', off.capMs === Infinity && whole.honoredMs === 3_600_000 && whole.spent === false, JSON.stringify(whole))
  process.env.MERCURY_RECOVERY_BUDGET_MINUTES = 'junk'
  t.check('the knob: junk ⇒ the default', budget.recoveryBudgetMs() === 5 * 60_000, String(budget.recoveryBudgetMs()))
  delete process.env.MERCURY_RECOVERY_BUDGET_MINUTES
  const facts = budget.recoveryNoticeFacts({ type: 'system', subtype: 'api_error', retryInMs: 40_000, retryAttempt: 2, maxRetries: 10, errorDetail: { status: 429 } })
  t.check('a recovery notice reads: the declared delay, the attempt numbers, the status', facts !== null && facts.declaredMs === 40_000 && facts.attempt === 2 && facts.of === 10 && facts.status === 429, JSON.stringify(facts))
  t.check('a blocking recovery ceiling reads as the declared wait', budget.recoveryNoticeFacts({ type: 'system', subtype: 'api_error', retryInMs: 0, recoveryTimeoutMs: 15_000 })?.declaredMs === 15_000, 'ceiling')
  t.check('a plain message is not a notice', budget.recoveryNoticeFacts({ type: 'assistant' }) === null && budget.recoveryNoticeFacts({ type: 'system', subtype: 'api_error', retryInMs: 0 }) === null, 'null')
}

t.section('S5 — the pulse paints the words; the manifest carries them')
{
  const queued = pulse.agentPulse({ state: 'start', waitWords: 'waiting for a seat — 3 of 3 held (a, b, c)' }, 0)
  t.check('a queued tile with gate words paints the words, never a bare queued', queued.kind === 'queued' && pulse.agentPulseWord(queued) === 'waiting for a seat — 3 of 3 held (a, b, c)', pulse.agentPulseWord(queued))
  t.check('a start tile without words says starting — nothing queues before a call', pulse.agentPulseWord(pulse.agentPulse({ state: 'start' }, 0)) === 'starting', pulse.agentPulseWord(pulse.agentPulse({ state: 'start' }, 0)))
  const now = Date.now()
  const seat = pulse.agentPulse({ state: 'progress', waiting: 'seat', waitWords: 'waiting for a seat — 2 of 2 held (a, the chat)', lastProgressAt: now }, now)
  t.check("a seat wait derives 'seat' and paints the sentence", seat.kind === 'seat' && pulse.agentPulseWord(seat) === 'waiting for a seat — 2 of 2 held (a, the chat)', pulse.agentPulseWord(seat))
  const backoff = pulse.agentPulse({ state: 'progress', waiting: 'provider-backoff', retryInMs: 40_000, retryAttempt: 3, waitWords: 'provider throttled — retry 3 of 10 in 40 s (HTTP 429); 4m 20s of the 5m retry budget left', lastProgressAt: now }, now)
  t.check('a backoff with words paints the retry sentence', backoff.kind === 'backoff' && pulse.agentPulseWord(backoff) === 'provider throttled — retry 3 of 10 in 40 s (HTTP 429); 4m 20s of the 5m retry budget left', pulse.agentPulseWord(backoff))
  const compact = pulse.agentPulse({ state: 'progress', waiting: 'provider-backoff', retryInMs: 40_000, retryAttempt: 3, lastProgressAt: now }, now)
  t.check('a backoff without words keeps the compact form', pulse.agentPulseWord(compact) === 'provider backoff · retry 3 · ~40s', pulse.agentPulseWord(compact))
  const summaries = manifest.buildAgentSummaries([
    { type: 'workflow_agent', index: 0, label: 'alpha', state: 'start', queuedAt: now, waitWords: 'waiting for a seat — 3 of 3 held (b, c, d)' } as never,
    { type: 'workflow_agent', index: 1, label: 'beta', state: 'progress', startedAt: now, lastProgressAt: now, waiting: 'seat', waitWords: 'waiting for a seat — 3 of 3 held (b, c, the chat)' } as never,
  ] as never)
  const alpha = summaries.find(s => s.label === 'alpha')
  const beta = summaries.find(s => s.label === 'beta')
  t.check('the manifest carries a queued agent\'s gate words', alpha?.waitWords === 'waiting for a seat — 3 of 3 held (b, c, d)', JSON.stringify(alpha))
  t.check("the manifest carries a seat-waiting agent's kind and words", beta?.waiting === 'seat' && beta.waitWords === 'waiting for a seat — 3 of 3 held (b, c, the chat)', JSON.stringify(beta))
}

t.section('S6 — the live facts: the held reading, the inherited stamp')
{
  cap._setHeldMachineSeatReadingForTesting(4)
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: false } }))
  const compose = await import('../../src/services/capacity/composeCeilings.js')
  const live = compose.liveCeilingFacts(null)
  t.check('the live facts read the held machine reading with its source', live.seats === 4 && live.seatSource === 'machine', JSON.stringify(live))
  process.env.MERCURY_SEATS = '7'
  const inherited = compose.liveCeilingFacts(null)
  t.check("the daemon's stamp wins and is named inherited", inherited.seats === 7 && inherited.seatSource === 'inherited', JSON.stringify(inherited))
  delete process.env.MERCURY_SEATS
  cap._setHeldMachineSeatReadingForTesting(null)
}

t.finish('prove-crew-seats')
