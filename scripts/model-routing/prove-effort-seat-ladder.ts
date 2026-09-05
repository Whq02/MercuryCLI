#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
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

const effort = await import('../../src/utils/effort.js')
const runner = await import('../../src/tools/AgentTool/runAgent.js')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')

const MODEL = 'claude-fable-5-1'
check(`${MODEL} serves max and xhigh (the ladder the proof walks)`, effort.modelSupportsMaxEffort(MODEL) && effort.modelSupportsXHighEffort(MODEL))

{
  console.log('\n— §1 · the call\'s word · the definition\'s word · the session\'s stamp · the default —')
  process.env.MERCURY_EFFORT_LEVEL = 'high'
  const session = effort.resolveEffortTruth(MODEL, 'medium')
  check("the session's own request: the stamp outranks the session's pick (medium → high, source env)", session.requested === 'high' && session.requestedSource === 'env' && session.applied === 'high', JSON.stringify(session))

  effort.noteAgentEffortWord('agent-own', 'max')
  const own = effort.resolveEffortTruth(MODEL, 'max', { agentId: 'agent-own' })
  check("an agent's own word ranks above the stamp on its request (asked max → max, source agent)", own.requested === 'max' && own.requestedSource === 'agent' && own.applied === 'max' && own.wire === 'max', JSON.stringify(own))
  check('the projections the lanes read carry the same word', effort.resolveWireRequestedEffort(MODEL, 'max', { agentId: 'agent-own' }) === 'max' && effort.resolveAppliedEffort(MODEL, 'max', { agentId: 'agent-own' }) === 'max')
  check("the same value WITHOUT the agent's id is the session's request (the stamp)", effort.resolveWireRequestedEffort(MODEL, 'max') === 'high' && effort.resolveAppliedEffort(MODEL, 'max') === 'high')
  check("the agent's own word stands even when the scoped value is absent", effort.resolveEffortTruth(MODEL, undefined, { agentId: 'agent-own' }).requested === 'max')

  const riding = effort.resolveEffortTruth(MODEL, 'medium', { agentId: 'agent-riding' })
  check("an agent riding the session's word (nothing noted) runs the stamp", riding.requested === 'high' && riding.requestedSource === 'env', JSON.stringify(riding))

  process.env.MERCURY_EFFORT_LEVEL = 'unset'
  const deferred = effort.resolveEffortTruth(MODEL, 'max', { agentId: 'agent-own' })
  check("a stamp of unset still yields to an agent's own word", deferred.requested === 'max' && deferred.requestedSource === 'agent', JSON.stringify(deferred))
  check('…while the session itself defers to the model default', effort.resolveEffortTruth(MODEL, 'max').requestedSource === 'env-suppressed')
  process.env.MERCURY_EFFORT_LEVEL = 'high'

  effort.noteAgentEffortWord('agent-own', 'xhigh')
  check('a re-noted word replaces the earlier one', effort.resolveEffortTruth(MODEL, 'xhigh', { agentId: 'agent-own' }).requested === 'xhigh')
  effort.noteAgentEffortWord('agent-own', undefined)
  check('noting undefined clears the word (the agent rides the stamp again)', effort.resolveEffortTruth(MODEL, 'max', { agentId: 'agent-own' }).requested === 'high')
  effort.noteAgentEffortWord('agent-own', 'max')
  effort.forgetAgentEffortWord('agent-own')
  check('the run ended: the word leaves the table', effort.agentOwnEffortWordOf('agent-own') === undefined && effort.resolveEffortTruth(MODEL, 'max', { agentId: 'agent-own' }).requestedSource === 'env')
  check('the session has no id and no own word', effort.agentOwnEffortWordOf(undefined) === undefined)

  const stamped = effort.resolveStampedEffortTruth(MODEL, 'xhigh')
  check("a seat row's stamped truth resolves the seat's own word (no env, no agent)", stamped.requested === 'xhigh' && stamped.requestedSource === 'session')
  const capped = effort.resolveStampedEffortTruth(MODEL, 'ultra')
  check('ultra asked on a first-party row runs max (the first-party ladder ends at max) and the record keeps the asked word', capped.applied === 'max' && capped.wire === 'max' && capped.adjustedFrom === 'ultra' && !effort.selectableEffortLevels(MODEL).includes('ultra'), JSON.stringify(capped))
  delete process.env.MERCURY_EFFORT_LEVEL
}

{
  console.log('\n— §2 · the runner notes the agent\'s OWN word —')
  const { agentOwnEffortWord, resolveAgentEffort } = runner
  check('the pin is the own word on a normal run', agentOwnEffortWord({ effortOverride: 'max', useExactTools: false, definitionEffort: 'low' }) === 'max')
  check('an exact-tools run ignores the pin (the definition is the own word)', agentOwnEffortWord({ effortOverride: 'max', useExactTools: true, definitionEffort: 'low' }) === 'low')
  check("no pin ⇒ the definition's word", agentOwnEffortWord({ effortOverride: undefined, useExactTools: false, definitionEffort: 'xhigh' }) === 'xhigh')
  check('no pin, no definition ⇒ no own word (the agent rides the session)', agentOwnEffortWord({ effortOverride: undefined, useExactTools: false, definitionEffort: undefined }) === undefined)
  check('a pin off the ladder yields to the definition, never rides raw', agentOwnEffortWord({ effortOverride: 'turbo', useExactTools: false, definitionEffort: 'medium' }) === 'medium')
  check('a spoken pin normalises through the one normaliser', agentOwnEffortWord({ effortOverride: 'x-high', useExactTools: false, definitionEffort: undefined }) === 'xhigh')
  check('resolveAgentEffort is the own word else the session (unchanged ladder)', resolveAgentEffort({ effortOverride: undefined, useExactTools: false, definitionEffort: undefined, sessionEffort: 'high' }) === 'high' && resolveAgentEffort({ effortOverride: 'max', useExactTools: false, definitionEffort: 'low', sessionEffort: 'high' }) === 'max')
  const src = readFileSync(join(ROOT, 'src/tools/AgentTool/runAgent.ts'), 'utf8')
  check('the runner notes the own word under the agent id once the claim is held, and forgets it with the claim', /executorClaims\.set\(agentId, claim\)[\s\S]{0,400}noteAgentEffortWord\(agentId, agentOwnEffortWord\(\{ effortOverride, useExactTools, definitionEffort: agentDefinition\.effort \}\)\)/.test(src) && /executorClaims\.delete\(agentId\)\s*\n\s*forgetAgentEffortWord\(agentId\)/.test(src))
  const machine = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
  check("the turn machine's byline resolution names the agent", machine.includes('resolveEffortTruth(iter.currentModel, effortValue, { agentId: toolUseContext.agentId })'))
  for (const [lane, needle] of [
    ['openai', "resolveWireRequestedEffort(modelId, options.effortValue, { agentId: options.agentId })"],
    ['zai', "resolveWireRequestedEffort(modelId, options.effortValue, { agentId: options.agentId })"],
    ['openaicompat', "resolveWireRequestedEffort(modelId, options.effortValue, { agentId: options.agentId })"],
    ['anthropic', "resolveAppliedEffort(options.model, options.effortValue, { agentId: options.agentId })"],
  ] as const) {
    const file = lane === 'openai' ? 'src/services/providers/openai/openaiCallModel.ts' : lane === 'zai' ? 'src/services/providers/zai/zaiCallModel.ts' : lane === 'openaicompat' ? 'src/services/providers/openaicompat/compatChatCallModel.ts' : 'src/services/providers/anthropic/streamCore.ts'
    check(`the ${lane} lane resolves its request effort with the agent id`, readFileSync(join(ROOT, file), 'utf8').includes(needle))
  }
}

{
  console.log('\n— §3 · a seat stamped high, an agent asking max, a live list serving it —')
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
  process.env.MERCURY_EFFORT_LEVEL = 'high'
  effort.noteAgentEffortWord('astra-deep', 'max')
  effort.noteAgentEffortWord('astra-quick', 'xhigh')
  const deep = effort.resolveEffortTruth('gpt-6-astra', 'max', { agentId: 'astra-deep' })
  const quick = effort.resolveEffortTruth('gpt-6-astra', 'xhigh', { agentId: 'astra-quick' })
  const seat = effort.resolveEffortTruth('gpt-6-astra', 'high')
  check("the deep agent's request carries max (asked max → sent max)", deep.wire === 'max' && deep.requestedSource === 'agent', JSON.stringify(deep))
  check("the quick agent's request carries xhigh", quick.wire === 'xhigh' && quick.requestedSource === 'agent', JSON.stringify(quick))
  check("the seat's own request still carries its stamp (high)", seat.wire === 'high' && seat.requestedSource === 'env', JSON.stringify(seat))
  const stepped = effort.resolveEffortTruth('gpt-5.5', 'max', { agentId: 'astra-deep' })
  check("an own word the row lacks steps to the nearest served word (max → xhigh) and the record keeps both", stepped.wire === 'xhigh' && stepped.requested === 'max' && stepped.adjustedFrom === 'max', JSON.stringify(stepped))
  effort.noteAgentEffortWord('astra-top', 'ultra')
  const top = effort.resolveEffortTruth('gpt-6-astra', 'ultra', { agentId: 'astra-top' })
  check('an agent asking the served top word sends it (asked ultra → sent ultra)', top.wire === 'ultra' && top.applied === 'ultra' && top.requestedSource === 'agent' && top.adjustedFrom === undefined, JSON.stringify(top))
  const topStepped = effort.resolveEffortTruth('gpt-5.5', 'ultra', { agentId: 'astra-top' })
  check('the same word on a row that lacks it steps to the nearest served word (ultra → xhigh) with both words on the record', topStepped.wire === 'xhigh' && topStepped.requested === 'ultra' && topStepped.adjustedFrom === 'ultra', JSON.stringify(topStepped))
  effort.forgetAgentEffortWord('astra-top')
  effort.forgetAgentEffortWord('astra-deep')
  effort.forgetAgentEffortWord('astra-quick')
  delete process.env.MERCURY_EFFORT_LEVEL
  catalogue.__resetOpenaiCatalogueForTest()
}

{
  console.log('\n— §4 · the receipt line and the typed stamp —')
  const line = effort.effortAdjustedReceiptLine({ model: 'gpt-5.5', name: 'GPT-5.5', asked: 'max', sent: 'xhigh' })
  check('the line names the asked word, the model and the served word', line === 'effort max is not served on GPT-5.5 today — sent xhigh', line)
  const omitted = effort.effortAdjustedReceiptLine({ model: 'gpt-5.5', name: 'GPT-5.5', asked: 'max' })
  check('a wire that omits the key says so', omitted === 'effort max is not served on GPT-5.5 today — no effort key was sent (the model default applies)', omitted)
  const sixth = effort.effortAdjustedReceiptLine({ model: 'gpt-5.5', name: 'GPT-5.5', asked: 'ultra', sent: 'xhigh' })
  check('the line names the sixth word the same way', sixth === 'effort ultra is not served on GPT-5.5 today — sent xhigh', sixth)
  const messageTypes = readFileSync(join(ROOT, 'src/types/message.ts'), 'utf8')
  check('the settled assistant message carries the typed stamp beside the typed end', /streamEnd\?: StreamEndV1[\s\S]{0,600}effortAdjusted\?: EffortAdjustedV1/.test(messageTypes))
  const lane = readFileSync(join(ROOT, 'src/services/providers/openai/openaiCallModel.ts'), 'utf8')
  check('the GPT lane stamps the adjustment on the settled message and no longer folds it into the reply text', lane.includes('lastMessage.effortAdjusted = ') && !lane.includes("is not in ${modelId}'s live effort catalogue"))
  const machine = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
  check('the turn machine paints the receipt row from the stamp, once per thread and word pair', machine.includes('const adjusted = settled.effortAdjusted') && machine.includes('effortAdjustedReceiptLine(adjusted)') && /effortAdjustmentsReceipted\.has\(key\)/.test(machine))
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
