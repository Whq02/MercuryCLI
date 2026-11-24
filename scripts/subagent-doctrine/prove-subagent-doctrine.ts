#!/usr/bin/env bun

import { buildCrewmateMercurySections } from '../../src/tools/crewmate/crewmateDoctrine.js'
import { MERCURY_CONSTITUTION, mercuryCrewmateContract } from '../../src/engine/system-prompt/mercuryContract.js'
import { MERCURY_SCOUT_AGENT } from '../../src/tools/crewmate/built-in/mercuryScoutAgent.js'


const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

let fail = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const GP = { agentType: 'mercury-crew' }
const EXEMPT = ['mercury-scout']
const NORMAL_MARK = 'You are one of Mercury\'s agents'
const GATE_CLAUSE = 'bypass a safety, permission, approval, or capability gate'
const join = (a: string[]) => a.join('\n')

console.log('============================================================')
console.log(' Subagent doctrine layer — stamp-gated proof')
console.log('============================================================')

section('(a) bare stamp ⇒ SAME sections (stamp-independence)')
setStamp(false)
const gpStock = JSON.stringify(buildCrewmateMercurySections({ agentDefinition: GP }))
const exemptStock = JSON.stringify(buildCrewmateMercurySections({ agentDefinition: { agentType: 'mercury-scout' } }))
setStamp(true)
check('mercury-crew: bare-stamped === full-stamped', gpStock === JSON.stringify(buildCrewmateMercurySections({ agentDefinition: GP })), '', 'buildSubagentMercurySections in src/tools/crewmate/crewmateDoctrine.ts must not read the MACRO stamp')
const seatSub = join(buildCrewmateMercurySections({ agentDefinition: GP }))
const seatCrew = join(buildCrewmateMercurySections({ agentDefinition: GP, seat: 'a crewmate' }))
check('the seat word is the one word: a plain spawn reads a crewmate', seatSub.includes("Mercury's agents, a crewmate, spawned for one assignment"), '', 'the seat word in buildSubagentMercurySections (src/tools/crewmate/crewmateDoctrine.ts) and mercurySubagentContract (src/engine/system-prompt/mercuryContract.ts) must default to a crewmate')
check('the seat word named outright reads the same', seatCrew.includes("Mercury's agents, a crewmate, spawned for one assignment"))
check('never the old word, never both', !seatSub.includes('or a crewmate') && !seatSub.includes('sub-agent') && !mercuryCrewmateContract('a crewmate').includes('sub-agent'), '', 'remove the old seat word from mercurySubagentContract in src/engine/system-prompt/mercuryContract.ts')
check('no capital for emphasis in the three contracts', !/\b[A-Z]{2,}\b/.test(mercuryCrewmateContract()), '', 'write the emphasised word in lower case in mercurySubagentContract in src/engine/system-prompt/mercuryContract.ts')

check('exempt agent: bare-stamped === full-stamped', exemptStock === JSON.stringify(buildCrewmateMercurySections({ agentDefinition: { agentType: 'mercury-scout' } })))

section('(b) stamped ⇒ the constitution leads, the ONE NORMAL doctrine')
setStamp(true)
{
  const s = buildCrewmateMercurySections({ agentDefinition: GP })
  check('returns a non-empty section list', s.length >= 2, `len=${s.length}`)
  check('section[0] is the constitution (LEADS)', s[0] === MERCURY_CONSTITUTION, '', 'buildSubagentMercurySections in src/tools/crewmate/crewmateDoctrine.ts must put MERCURY_CONSTITUTION first')
  check('NORMAL doctrine present', join(s).includes(NORMAL_MARK) && join(s).includes('<subagent-doctrine>'), '', 'buildSubagentMercurySections in src/tools/crewmate/crewmateDoctrine.ts must include the doctrine block with its opening mark')
}

section('(c) the fixed-output agents get the SAME NORMAL doctrine as mercury-crew')
for (const a of EXEMPT) {
  const s = join(buildCrewmateMercurySections({ agentDefinition: { agentType: a } }))
  check(`${a}: NORMAL doctrine (one register for every agent)`, s.includes(NORMAL_MARK) && s.includes('<subagent-doctrine>'))
}

section('(d) C14: exempt Set DERIVED from fixedOutputContract (membership, not a string literal)')
{
  const { isFixedOutputAgent } = await import('../../src/tools/crewmate/crewmateDoctrine.ts')
  for (const def of [MERCURY_SCOUT_AGENT]) {
    check(`${def.agentType}: def carries fixedOutputContract:true`, def.fixedOutputContract === true, '', 'set fixedOutputContract: true on the agent definition in src/tools/crewmate/built-in/mercuryScoutAgent.ts')
    check(`${def.agentType}: agentType ∈ derived exempt Set`, isFixedOutputAgent({ agentType: def.agentType }), '', 'isFixedOutputAgent in src/tools/crewmate/crewmateDoctrine.ts must derive its set from agents carrying fixedOutputContract')
  }
  check('a non-flagged agent (mercury-crew) is NOT exempt', !isFixedOutputAgent(GP))
  check('a made-up agentType is NOT exempt (no drift to over-exempting)', !isFixedOutputAgent({ agentType: 'not-a-real-fixed-output-agent' }))
}


section('(e) memory front page — every agent receives it; the memory switch removes it')
check('mercury-crew carries the memory front page', join(buildCrewmateMercurySections({ agentDefinition: GP })).includes('# Memory'), '', 'buildSubagentMercurySections in src/tools/crewmate/crewmateDoctrine.ts must include the memory front page from src/sessions/mneme/mnemeFrontPage.ts')
for (const a of EXEMPT) {
  check(`${a}: carries the memory front page (crewmates get the pinned rules)`, join(buildCrewmateMercurySections({ agentDefinition: { agentType: a } })).includes('# Memory'))
}
process.env.MERCURY_BARE = '1'
check('memory off: no front page in the doctrine', !join(buildCrewmateMercurySections({ agentDefinition: GP })).includes('# Memory'), '', 'buildSubagentMercurySections in src/tools/crewmate/crewmateDoctrine.ts must leave the front page out when MERCURY_BARE is set')
delete process.env.MERCURY_BARE

section('(e1) memory front page — the verb sentence rides only with a reader that has the verbs; an empty library is one sentence')
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const priorHome = process.env.MERCURY_CONFIG_DIR
  const scratchHome = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'doctrine-memory-'))
  process.env.MERCURY_CONFIG_DIR = scratchHome
  try {
    const { MEMORY_WRITE_VERBS_SENTENCE } = await import('../../src/sessions/mneme/mnemeFrontPage.js')
    const memoryOf = (sections: string[]): string => sections.find(s => s.startsWith('# Memory')) ?? ''
    const emptyCrew = memoryOf(buildCrewmateMercurySections({ agentDefinition: GP }))
    const emptyScout = memoryOf(buildCrewmateMercurySections({ agentDefinition: { agentType: 'mercury-scout' } }))
    check('an empty library is the heading and one sentence for every agent — no index, no pinned tier painted', emptyCrew.split('\n').length === 2 && emptyScout.split('\n').length === 2 && !emptyCrew.includes('## Index') && !emptyCrew.includes('## Pinned'), emptyCrew, 'the front page in src/sessions/mneme/mnemeFrontPage.ts must be a heading and one sentence when the library is empty')
    check('the empty page says when memory is written only for a reader that can write it, and Recall for both', emptyCrew.includes('Memory is written only when the user asks for something to be remembered') && !emptyScout.includes('written only when') && !emptyScout.includes('Retain') && emptyCrew.includes('Recall') && emptyScout.includes('Recall'), emptyScout, 'the front page in src/sessions/mneme/mnemeFrontPage.ts must give the when-rule only to a reader that can write memory')
    check('the two empty pages differ only by the when-rule', emptyCrew.replace(' Memory is written only when the user asks for something to be remembered;', '') === emptyScout)
    const { appendObservation } = await import('../../src/sessions/mneme/mnemeBuffer.js')
    const { maybeConsolidate } = await import('../../src/sessions/mneme/mnemeConsolidate.js')
    const { mnemeLibraryDir } = await import('../../src/sessions/mneme/mnemeGates.js')
    const { readPins } = await import('../../src/sessions/mneme/mnemeUsage.js')
    const dir = mnemeLibraryDir()
    appendObservation({ text: 'the harbour gate opens after the smoke suite', source: 'proof', topicHint: 'harbour' }, dir)
    appendObservation({ text: 'say what happened first, then what it means', source: 'proof', topicHint: 'rules', pin: true, asked: true }, dir)
    check('the scratch library landed a fact and a pinned rule', maybeConsolidate({ force: true, dir, now: new Date('2026-01-01T00:00:00Z') }).consolidated === true && readPins(dir).some(p => p.asked === true))
    const crew = memoryOf(buildCrewmateMercurySections({ agentDefinition: GP }))
    const scout = memoryOf(buildCrewmateMercurySections({ agentDefinition: { agentType: 'mercury-scout' } }))
    check('the crew front page names Retain and Correct', crew.includes(MEMORY_WRITE_VERBS_SENTENCE))
    check("the scout's front page carries the index and the pinned shelf", scout.includes('## Index') && scout.includes('## Pinned') && scout.includes('say what happened first'), scout, 'the front page in src/sessions/mneme/mnemeFrontPage.ts must show the index and pinned shelf once the library has them')
    check("the scout's front page names no verb it cannot call (Retain, Correct)", !scout.includes('Retain') && !scout.includes('Correct') && !scout.includes(MEMORY_WRITE_VERBS_SENTENCE), scout.split('\n')[1]?.slice(0, 200), 'the front page in src/sessions/mneme/mnemeFrontPage.ts must leave the write-verb sentence out for an agent without Retain and Correct')
    check("the scout's page still names Recall, which it has", scout.includes('Recall'))
    check('the two pages differ only by the verb sentence', crew.replace(` ${MEMORY_WRITE_VERBS_SENTENCE}`, '') === scout)
    const reader = memoryOf(buildCrewmateMercurySections({ agentDefinition: { agentType: 'quiet-reader' }, toolNames: new Set(['Read', 'Grep']) }))
    const writer = memoryOf(buildCrewmateMercurySections({ agentDefinition: { agentType: 'remembering' }, toolNames: new Set(['Read', 'Grep', 'Retain', 'Recall', 'Reflect', 'Correct']) }))
    check('a custom agent whose tools lack Retain gets the reading page', !reader.includes('Retain') && reader.includes('## Pinned'))
    check('a custom agent granted the memory verbs gets the full page', writer.includes(MEMORY_WRITE_VERBS_SENTENCE))
    check('with no tool list given (the fork path) the full page stands', memoryOf(buildCrewmateMercurySections({ agentDefinition: GP })).includes(MEMORY_WRITE_VERBS_SENTENCE))
  } finally {
    if (priorHome === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = priorHome
    rmSync(scratchHome, { recursive: true, force: true })
  }
}

section('(e2) API-currency: the env block carries the rule once; the doctrine sections repeat nothing')
{
  const CURRENCY_MARK = 'provider-apis'
  for (const a of ['mercury-crew', ...EXEMPT]) {
    check(`${a}: the doctrine sections carry no provider-apis line of their own`, !join(buildCrewmateMercurySections({ agentDefinition: { agentType: a } })).includes(CURRENCY_MARK))
  }
}

section('(f) gate clause present in the operating block; no softener')
{
  const normalBlock = buildCrewmateMercurySections({ agentDefinition: GP })[1]
  check('NORMAL block keeps the never-bypass-a-gate clause', normalBlock.includes(GATE_CLAUSE), '', 'restore the never-bypass-a-gate clause in the doctrine block built by src/tools/crewmate/crewmateDoctrine.ts')
  const SOFTENERS = [/may bypass/i, /skip the gate/i, /ok to bypass/i, /no need to confirm/i]
  check('the block contains no gate-softener', !SOFTENERS.some(re => re.test(normalBlock)), '', 'remove the gate-softening words from the doctrine block built by src/tools/crewmate/crewmateDoctrine.ts')
}

setStamp(false)
console.log('\n' + '═'.repeat(76))
if (fail === 0) console.log('✅ ALL SUBAGENT-DOCTRINE PROOFS PASS')
else console.log(`❌ ${fail} SUBAGENT-DOCTRINE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(fail === 0 ? 0 : 1)
