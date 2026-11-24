#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
const failureWhere = 'change resolveEffortTruth, noteAgentEffortWord or effortAdjustedReceiptLine in src/models/effort/effort.ts, agentOwnEffortWord or resolveAgentEffort in src/tools/crewmate/runCrewmate.ts, or effortSentOf in src/engine/connector/seatProjections.ts, whichever the check names'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ' — ' + (detail ? detail + ' — ' : '') + failureWhere : ''}`)
}

console.log('============================================================')
console.log(' the effort seat ladder (the stamp is a floor, not a ceiling)')
console.log('============================================================')

const savedEnv: Record<string, string | undefined> = {}
for (const key of ['OPENAI_API_KEY', 'MERCURY_CONFIG_DIR', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_EFFORT_LEVEL', 'MERCURY_OPENAI_API_BASE']) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-effort-seat-'))
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

const effort = await import('../../src/models/effort/effort.js')
const runner = await import('../../src/tools/crewmate/runCrewmate.js')
const catalogue = await import('../../src/models/roads/openai/openaiCatalogue.js')

const MODEL = 'claude-fable-5-1'
check(`${MODEL} serves max and xhigh (the ladder the proof walks)`, effort.modelSupportsMaxEffort(MODEL) && effort.modelSupportsXHighEffort(MODEL))

{
  console.log('\n— §1 · the call\'s word · the definition\'s word · the session\'s stamp · the default —')
  process.env.MERCURY_EFFORT_LEVEL = 'high'
  const session = effort.resolveEffortTruth(MODEL, 'medium')
  check("the session's own request: the stamp outranks the session's pick (medium → high, source env)", session.requested === 'high' && session.requestedSource === 'env' && session.applied === 'high', JSON.stringify(session))

  effort.noteCrewmateEffortWord('agent-own', 'max')
  const own = effort.resolveEffortTruth(MODEL, 'max', { agentId: 'agent-own' })
  check("a crewmate's own word ranks above the stamp on its request (asked max → max, source agent)", own.requested === 'max' && own.requestedSource === 'agent' && own.applied === 'max' && own.wire === 'max', JSON.stringify(own))
  check('the projections the lanes read carry the same word', effort.resolveWireRequestedEffort(MODEL, 'max', { agentId: 'agent-own' }) === 'max' && effort.resolveAppliedEffort(MODEL, 'max', { agentId: 'agent-own' }) === 'max')
  check("the same value WITHOUT the agent's id is the session's request (the stamp)", effort.resolveWireRequestedEffort(MODEL, 'max') === 'high' && effort.resolveAppliedEffort(MODEL, 'max') === 'high')
  check("the agent's own word stands even when the scoped value is absent", effort.resolveEffortTruth(MODEL, undefined, { agentId: 'agent-own' }).requested === 'max')
  const pinnedCall = effort.resolveEffortTruth(MODEL, 'low', { agentId: 'agent-own', pinned: true })
  check("a pinned call's own value outranks the agent's own word AND the stamp (a utility call at its floor: asked low → low, source pinned)", pinnedCall.requested === 'low' && pinnedCall.requestedSource === 'pinned' && pinnedCall.applied === 'low' && pinnedCall.wire === 'low' && effort.resolveWireRequestedEffort(MODEL, 'low', { agentId: 'agent-own', pinned: true }) === 'low' && effort.resolveAppliedEffort(MODEL, 'low', { agentId: 'agent-own', pinned: true }) === 'low', JSON.stringify(pinnedCall))
  check('a pinned call with no value of its own asks nothing (never the stamp, never the own word)', effort.resolveEffortTruth(MODEL, undefined, { agentId: 'agent-own', pinned: true }).requested === undefined)

  const riding = effort.resolveEffortTruth(MODEL, 'medium', { agentId: 'agent-riding' })
  check("an agent riding the session's word (nothing noted) runs the stamp", riding.requested === 'high' && riding.requestedSource === 'env', JSON.stringify(riding))

  process.env.MERCURY_EFFORT_LEVEL = 'unset'
  const deferred = effort.resolveEffortTruth(MODEL, 'max', { agentId: 'agent-own' })
  check("a stamp of unset still yields to a crewmate's own word", deferred.requested === 'max' && deferred.requestedSource === 'agent', JSON.stringify(deferred))
  check('…while the session itself defers to the model default', effort.resolveEffortTruth(MODEL, 'max').requestedSource === 'env-suppressed')
  process.env.MERCURY_EFFORT_LEVEL = 'high'

  effort.noteCrewmateEffortWord('agent-own', 'xhigh')
  check('a re-noted word replaces the earlier one', effort.resolveEffortTruth(MODEL, 'xhigh', { agentId: 'agent-own' }).requested === 'xhigh')
  effort.noteCrewmateEffortWord('agent-own', undefined)
  check('noting undefined clears the word (the agent rides the stamp again)', effort.resolveEffortTruth(MODEL, 'max', { agentId: 'agent-own' }).requested === 'high')
  effort.noteCrewmateEffortWord('agent-own', 'max')
  effort.forgetCrewmateEffortWord('agent-own')
  check('the run ended: the word leaves the table', effort.crewmateOwnEffortWordOf('agent-own') === undefined && effort.resolveEffortTruth(MODEL, 'max', { agentId: 'agent-own' }).requestedSource === 'env')
  check('the session has no id and no own word', effort.crewmateOwnEffortWordOf(undefined) === undefined)

  const stamped = effort.resolveStampedEffortTruth(MODEL, 'xhigh')
  check("a seat row's stamped truth resolves the seat's own word (no env, no agent)", stamped.requested === 'xhigh' && stamped.requestedSource === 'session')
  check('the ladder ends at max and a word above it is not a level (no door admits it; the ceiling is max)', effort.EFFORT_LEVELS[effort.EFFORT_LEVELS.length - 1] === 'max' && effort.normalizeEffortLevelString('ultra') === undefined && effort.parseEffortValue('ultra') === undefined && effort.getMaxSupportedEffortLevel(MODEL) === 'max' && !(effort.selectableEffortLevels(MODEL) as readonly string[]).includes('ultra'))
  delete process.env.MERCURY_EFFORT_LEVEL
}

{
  console.log('\n— §2 · the runner notes the agent\'s OWN word —')
  const { crewmateOwnEffortWord, resolveCrewmateEffort } = runner
  check('the pin is the own word on a normal run', crewmateOwnEffortWord({ effortOverride: 'max', useExactTools: false, definitionEffort: 'low' }) === 'max')
  check('an exact-tools run ignores the pin (the definition is the own word)', crewmateOwnEffortWord({ effortOverride: 'max', useExactTools: true, definitionEffort: 'low' }) === 'low')
  check("no pin ⇒ the definition's word", crewmateOwnEffortWord({ effortOverride: undefined, useExactTools: false, definitionEffort: 'xhigh' }) === 'xhigh')
  check('no pin, no definition ⇒ no own word (the agent rides the session)', crewmateOwnEffortWord({ effortOverride: undefined, useExactTools: false, definitionEffort: undefined }) === undefined)
  check('a pin off the ladder yields to the definition, never rides raw', crewmateOwnEffortWord({ effortOverride: 'turbo', useExactTools: false, definitionEffort: 'medium' }) === 'medium')
  check('a spoken pin normalises through the one normaliser', crewmateOwnEffortWord({ effortOverride: 'x-high', useExactTools: false, definitionEffort: undefined }) === 'xhigh')
  check("resolveAgentEffort is the own word else the configured sub-agent default (the session's word is not a rung)", resolveCrewmateEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: undefined, defaultEffort: 'high' }) === 'high' && resolveCrewmateEffort({ effortOverride: 'max', useExactTools: false, definitionEffort: 'low', defaultEffort: 'high' }) === 'max' && resolveCrewmateEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: 'low', defaultEffort: 'high' }) === 'low')
}

{
  console.log('\n— §3 · a seat stamped max, agents asking their own words, a live list serving them —')
  process.env.OPENAI_API_KEY = 'prover-key'
  const fixtureFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_reasoning_level: 'high' },
          { id: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 2, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'], default_reasoning_level: 'high' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fixtureFetch })
  process.env.MERCURY_EFFORT_LEVEL = 'max'
  effort.noteCrewmateEffortWord('astra-deep', 'max')
  effort.noteCrewmateEffortWord('astra-quick', 'xhigh')
  const deep = effort.resolveEffortTruth('gpt-6-astra', 'max', { agentId: 'astra-deep' })
  const quick = effort.resolveEffortTruth('gpt-6-astra', 'xhigh', { agentId: 'astra-quick' })
  const seat = effort.resolveEffortTruth('gpt-6-astra', 'high')
  check("the deep agent's request carries max (asked max → sent max)", deep.wire === 'max' && deep.requestedSource === 'agent', JSON.stringify(deep))
  check("the quick agent's request carries xhigh", quick.wire === 'xhigh' && quick.requestedSource === 'agent', JSON.stringify(quick))
  check("the seat's own request still carries its stamp (max)", seat.wire === 'max' && seat.requestedSource === 'env', JSON.stringify(seat))
  const stepped = effort.resolveEffortTruth('gpt-5.5', 'max', { agentId: 'astra-deep' })
  check("an own word the row lacks steps to the nearest served word (max → xhigh) and the record keeps both", stepped.wire === 'xhigh' && stepped.requested === 'max' && stepped.adjustedFrom === 'max', JSON.stringify(stepped))
  effort.noteCrewmateEffortWord('astra-top', 'ultra' as never)
  const top = effort.resolveEffortTruth('gpt-6-astra', 'ultra' as never, { agentId: 'astra-top' })
  check("a list word above the ladder is never sent: asked raw, the row default (high on this list) rides", top.wire === 'high' && top.applied === 'high' && top.requestedSource === 'agent', JSON.stringify(top))
  effort.noteCrewmateEffortWord('astra-default', 'high')
  const riding = effort.resolveEffortTruth('gpt-6-astra', 'high', { agentId: 'astra-default' })
  check("a sub-agent on the configured default keeps it under a seat stamped max (the stamp is the seat's, never the crew's)", riding.wire === 'high' && riding.requestedSource === 'agent', JSON.stringify(riding))
  effort.forgetCrewmateEffortWord('astra-default')
  effort.forgetCrewmateEffortWord('astra-top')
  effort.forgetCrewmateEffortWord('astra-deep')
  effort.forgetCrewmateEffortWord('astra-quick')
  delete process.env.MERCURY_EFFORT_LEVEL
  catalogue.__resetOpenaiCatalogueForTest()
}

{
  console.log('\n— §4 · the receipt line and the typed stamp —')
  const line = effort.effortAdjustedReceiptLine({ model: 'gpt-5.5', name: 'GPT-5.5', asked: 'max', sent: 'xhigh' })
  check('the line names the asked word, the model and the served word', line === 'effort max is not served on GPT-5.5 today — sent xhigh', line)
  const omitted = effort.effortAdjustedReceiptLine({ model: 'gpt-5.5', name: 'GPT-5.5', asked: 'max' })
  check('a wire that omits the key says so', omitted === 'effort max is not served on GPT-5.5 today — no effort key was sent (the model default applies)', omitted)
  const refused = effort.effortAdjustedReceiptLine({ model: 'gpt-5.5', name: 'GPT-5.5', asked: 'max', sent: 'xhigh', wireRefused: { road: 'ChatGPT subscription', reprobeAfter: 'a day' } })
  check('a wire-refused word names the road and the re-probe', refused === 'effort max: the wire refused it for GPT-5.5 on the ChatGPT subscription road today — sent xhigh, the nearest word it serves; Mercury asks the wire again after a day', refused)
  const refusedNoKey = effort.effortAdjustedReceiptLine({ model: 'gpt-5.5', name: 'GPT-5.5', asked: 'max', wireRefused: { road: 'API key', reprobeAfter: 'a day' } })
  check('…and with no key sent the line says the model default applies', refusedNoKey === 'effort max: the wire refused it for GPT-5.5 on the API key road today — no effort key was sent (the model default applies); Mercury asks the wire again after a day', refusedNoKey)
  const t = await import('../core-runtime/turnScenarios.ts')
  const receiptsOf = async (stamp: Record<string, unknown>, agentId?: string): Promise<string> => {
    const run = await t.runScripted({
      ...(agentId !== undefined ? { agentId, querySource: 'agent:custom' } : {}),
      script: [t.fixtures.yields(Object.assign(t.fixtures.says('the reply at the lower effort.'), { effortAdjusted: stamp }))],
    })
    return t.noticesOf(run.events).join(' | ') || 'no row'
  }
  const pair = { model: 'gpt-5.5', name: 'GPT-5.5', asked: 'max', sent: 'xhigh' }
  const otherPair = { ...pair, sent: 'high' }
  const painted = {
    'the first reply stamped max>xhigh': await receiptsOf(pair),
    'a second reply with the same pair': await receiptsOf(pair),
    'a reply stamped max>high': await receiptsOf(otherPair),
    'the first pair on a crewmate thread': await receiptsOf(pair, t.fixtures.agent()),
    'the same pair again on that thread': await receiptsOf(pair, t.fixtures.agent()),
  }
  check(
    'the turn machine paints the receipt row from the stamp, once per thread and word pair',
    Object.values(painted).join(' / ') === [line, 'no row', effort.effortAdjustedReceiptLine(otherPair), line, 'no row'].join(' / '),
    `the model call (streamModel, src/engine/loop/turn/streamModel.ts) must yield effortAdjustedReceiptLine(stamp) as a notice for a settled reply stamped effortAdjusted, once for each thread, model and asked>sent pair in the process — ${JSON.stringify(painted)}`,
  )
}

console.log('\n— the sent word: resolved · no key · unresolved —')
{
  const { effortSentOf } = await import('../../src/engine/connector/seatProjections.ts')
  const live = { supportsEffort: true, wire: 'xhigh', catalogue: 'gpt-live' } as const
  const unstated = { supportsEffort: true, wire: undefined, catalogue: 'gpt-unstated' } as const
  const unavailable = { supportsEffort: true, wire: undefined, catalogue: 'gpt-unavailable' } as const
  const noKey = { supportsEffort: false, wire: undefined, catalogue: 'gpt-known-empty' } as const
  check('a served ladder resolves to the wire word (the nearest served word for the asked one)', effortSentOf(live) === 'xhigh')
  check("an UNFETCHED ladder is UNRESOLVED — the key absent (undefined), never the no-key spelling", effortSentOf(unstated) === undefined)
  check('an unreachable catalogue sends no key (null) — the wire omits it', effortSentOf(unavailable) === null)
  check('a model that takes no effort sends no key (null)', effortSentOf(noKey) === null)
  const { FIXTURE_MODEL, liveFactsOf, withFixtureRunner } = await import('../lib/builtProduct.ts')
  const SEAT_MODEL = 'claude-sonnet-4-6'
  const asked = [undefined, ...effort.EFFORT_LEVELS]
  const seatSent = await withFixtureRunner([], async host => {
    const sent: unknown[] = []
    for (const word of asked) {
      if (word !== undefined) await host.request('session/set_effort', { effort: word }).catch(() => null)
      sent.push((await liveFactsOf(host)).effortSent)
    }
    await host.request('session/set_effort', { effort: 'xhigh' }).catch(() => null)
    await host.request('session/set_model', { model: FIXTURE_MODEL }).catch(() => null)
    sent.push((await liveFactsOf(host)).effortSent)
    return sent
  }, { model: SEAT_MODEL })
  const sentBy = (model: string, word: (typeof asked)[number]): unknown => effortSentOf(effort.resolveEffortTruth(model, word))
  check("the runner's facts answer spells the sent word through the one owner, leaving the key ABSENT while unresolved", JSON.stringify(seatSent) === JSON.stringify([...asked.map(word => sentBy(SEAT_MODEL, word)), sentBy(FIXTURE_MODEL, 'xhigh')]) && seatSent[asked.indexOf('xhigh')] === 'high' && sentBy(FIXTURE_MODEL, 'xhigh') !== 'high', JSON.stringify(seatSent))
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('ALL EFFORT SEAT-LADDER PROOFS PASS')
else console.log(`${failures} EFFORT SEAT-LADDER PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
