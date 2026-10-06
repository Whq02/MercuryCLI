#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { buildSubagentMercurySections } from '../../src/constants/subagentDoctrine.js'
import { MERCURY_IDENTITY_FLOOR, mercurySubagentContract } from '../../src/prompt/mercuryContract.js'
import { MERCURY_SCOUT_AGENT } from '../../src/tools/AgentTool/built-in/mercuryScoutAgent.js'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf-8')

const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const GP = { agentType: 'mercury-crew' }
const EXEMPT = ['mercury-scout', 'workflow-subagent']
const NORMAL_MARK = 'You are one of Mercury\'s agents'
const GATE_CLAUSE = 'bypass a safety, permission, approval, or capability gate'
const join = (a: string[]) => a.join('\n')

console.log('============================================================')
console.log(' Subagent doctrine layer — stamp-gated proof')
console.log('============================================================')

section('(a) bare stamp ⇒ SAME sections (stamp-independence)')
setStamp(false)
const gpStock = JSON.stringify(buildSubagentMercurySections({ agentDefinition: GP }))
const exemptStock = JSON.stringify(buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-scout' } }))
setStamp(true)
check('mercury-crew: bare-stamped === full-stamped', gpStock === JSON.stringify(buildSubagentMercurySections({ agentDefinition: GP })))
const seatSub = join(buildSubagentMercurySections({ agentDefinition: GP }))
const seatCrew = join(buildSubagentMercurySections({ agentDefinition: GP, seat: 'a crewmate' }))
check('the seat word is the one word: a plain spawn reads a crewmate', seatSub.includes("Mercury's agents, a crewmate, spawned for one assignment"))
check('the seat word named outright reads the same', seatCrew.includes("Mercury's agents, a crewmate, spawned for one assignment"))
check('never the old word, never both', !seatSub.includes('or a crewmate') && !seatSub.includes('sub-agent') && !mercurySubagentContract('a crewmate').includes('sub-agent'))
check('no capital for emphasis in the three contracts', !/\b[A-Z]{2,}\b/.test(mercurySubagentContract()))

check('exempt agent: bare-stamped === full-stamped', exemptStock === JSON.stringify(buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-scout' } })))

section('(b) stamped ⇒ floor leads, the ONE NORMAL doctrine')
setStamp(true)
{
  const s = buildSubagentMercurySections({ agentDefinition: GP })
  check('returns a non-empty section list', s.length >= 2, `len=${s.length}`)
  check('section[0] is the identity floor (LEADS)', s[0] === MERCURY_IDENTITY_FLOOR)
  check('NORMAL doctrine present', join(s).includes(NORMAL_MARK) && join(s).includes('<subagent-doctrine>'))
}

section('(c) the fixed-output agents get the SAME NORMAL doctrine as mercury-crew')
for (const a of EXEMPT) {
  const s = join(buildSubagentMercurySections({ agentDefinition: { agentType: a } }))
  check(`${a}: NORMAL doctrine (one register for every agent)`, s.includes(NORMAL_MARK) && s.includes('<subagent-doctrine>'))
}

section('(d) C14: exempt Set DERIVED from fixedOutputContract (membership, not a string literal)')
{
  const { isFixedOutputAgent } = await import('../../src/constants/subagentDoctrine.ts')
  for (const def of [MERCURY_SCOUT_AGENT]) {
    check(`${def.agentType}: def carries fixedOutputContract:true`, def.fixedOutputContract === true)
    check(`${def.agentType}: agentType ∈ derived exempt Set`, isFixedOutputAgent({ agentType: def.agentType }))
  }
  check("'workflow-subagent' literal ∈ derived exempt Set", isFixedOutputAgent({ agentType: 'workflow-subagent' }))
  check('a non-flagged agent (mercury-crew) is NOT exempt', !isFixedOutputAgent(GP))
  check('a made-up agentType is NOT exempt (no drift to over-exempting)', !isFixedOutputAgent({ agentType: 'not-a-real-fixed-output-agent' }))
}

section('(d2) C14 source — derived Set (not a string literal) + WORKFLOW_SUBAGENT_DEF flagged')
{
  const sd = read('../../src/constants/subagentDoctrine.ts')
  check('exempt Set is DERIVED via .filter(d => d.fixedOutputContract)', sd.includes('.filter(d => d.fixedOutputContract)') && sd.includes(".concat('workflow-subagent')"))
  const ah = read('../../src/tools/WorkflowTool/agentHooks.ts')
  check('WORKFLOW_SUBAGENT_DEF carries fixedOutputContract: true', /WORKFLOW_SUBAGENT_DEF = \{[\s\S]{0,900}fixedOutputContract: true/.test(ah))
  const la = read('../../src/tools/AgentTool/loadAgentsDir.ts')
  check('BaseAgentDefinition declares fixedOutputContract?: boolean', la.includes('fixedOutputContract?: boolean'))
}

section('(e) memory front page — every agent receives it; the memory switch removes it')
check('mercury-crew carries the memory front page', join(buildSubagentMercurySections({ agentDefinition: GP })).includes('# Memory'))
for (const a of EXEMPT) {
  check(`${a}: carries the memory front page (crewmates get the pinned rules)`, join(buildSubagentMercurySections({ agentDefinition: { agentType: a } })).includes('# Memory'))
}
process.env.MERCURY_BARE = '1'
check('memory off: no front page in the doctrine', !join(buildSubagentMercurySections({ agentDefinition: GP })).includes('# Memory'))
delete process.env.MERCURY_BARE

section('(e1) memory front page — the verb sentence rides only with a reader that has the verbs')
{
  const { MEMORY_WRITE_VERBS_SENTENCE } = await import('../../src/mneme/mnemeFrontPage.js')
  const memoryOf = (sections: string[]): string => sections.find(s => s.startsWith('# Memory')) ?? ''
  const crew = memoryOf(buildSubagentMercurySections({ agentDefinition: GP }))
  const scout = memoryOf(buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-scout' } }))
  check('the crew front page names Retain and Correct', crew.includes(MEMORY_WRITE_VERBS_SENTENCE))
  check("the scout's front page carries the index and the pinned shelf", scout.includes('## Index') && scout.includes('## Pinned'))
  check("the scout's front page names no verb it cannot call (Retain, Correct)", !scout.includes('Retain') && !scout.includes('Correct') && !scout.includes(MEMORY_WRITE_VERBS_SENTENCE), scout.split('\n')[1]?.slice(0, 200))
  check("the scout's page still names Recall, which it has", scout.includes('Recall'))
  check('the two pages differ only by the verb sentence and the empty-index words', crew.replace(` ${MEMORY_WRITE_VERBS_SENTENCE}`, '').replace('(nothing saved yet — Retain saves the first fact)', '(nothing saved yet)') === scout)
  const reader = memoryOf(buildSubagentMercurySections({ agentDefinition: { agentType: 'quiet-reader' }, toolNames: new Set(['Read', 'Grep']) }))
  const writer = memoryOf(buildSubagentMercurySections({ agentDefinition: { agentType: 'remembering' }, toolNames: new Set(['Read', 'Grep', 'Retain', 'Recall', 'Reflect', 'Correct']) }))
  check('a custom agent whose tools lack Retain gets the reading page', !reader.includes('Retain') && reader.includes('## Pinned'))
  check('a custom agent granted the memory verbs gets the full page', writer.includes(MEMORY_WRITE_VERBS_SENTENCE))
  check('with no tool list given (the fork path) the full page stands', memoryOf(buildSubagentMercurySections({ agentDefinition: GP })).includes(MEMORY_WRITE_VERBS_SENTENCE))
}

section('(e2) API-currency: doctrine line for ALL agents + env-block currency note')
{
  const CURRENCY_MARK = 'provider-apis'
  check('mercury-crew carries the API-currency line', join(buildSubagentMercurySections({ agentDefinition: GP })).includes(CURRENCY_MARK))
  for (const a of EXEMPT) {
    check(`${a}: carries the API-currency line (fact line, not a register)`, join(buildSubagentMercurySections({ agentDefinition: { agentType: a } })).includes(CURRENCY_MARK))
  }
  const doctrine = join(buildSubagentMercurySections({ agentDefinition: GP }))
  check('the line ranks provider-apis over any external provider-API skill and bundled skills over same-named external ones', doctrine.includes('it outranks any external provider-API skill, and Mercury\'s bundled skills outrank external skills of the same name'))
  check('the line names no external skill', !doctrine.includes(['claude', '-api'].join('')) && !doctrine.includes('legacy variants'))
  const pr = read('../../src/constants/prompts.ts')
  const envFn = pr.slice(pr.indexOf('export async function computeEnvInfo'), pr.indexOf('export async function computeSimpleEnvInfo'))
  check('computeEnvInfo interpolates MODEL_CURRENCY_NOTE', envFn.includes('${MODEL_CURRENCY_NOTE}'))
  check('…for EVERY family (no route gate on the currency rule)', !envFn.includes('isAnthropicRoutedModelId'))
  check('the model_currency section shares the same const (no drift-prone twin literal)', pr.includes('function getModelCurrencySection(): string {\n  return `${MODEL_CURRENCY_NOTE} ${PROVIDER_SKILL_PRECEDENCE}`\n}'))
  check('MODEL_CURRENCY_NOTE is the neutral rule — no vendor model list hardcoded', /MODEL_CURRENCY_NOTE = `Model currency:/.test(pr) && !/MODEL_CURRENCY_NOTE = `[^`]*claude-/.test(pr))
}

section('(f) gate clause present in the operating block; no softener')
{
  const normalBlock = buildSubagentMercurySections({ agentDefinition: GP })[1]
  check('NORMAL block keeps the never-bypass-a-gate clause', normalBlock.includes(GATE_CLAUSE))
  const SOFTENERS = [/may bypass/i, /skip the gate/i, /ok to bypass/i, /no need to confirm/i]
  check('the block contains no gate-softener', !SOFTENERS.some(re => re.test(normalBlock)))
}

setStamp(false)
console.log('\n' + '═'.repeat(76))
if (fail === 0) console.log('✅ ALL SUBAGENT-DOCTRINE PROOFS PASS')
else console.log(`❌ ${fail} SUBAGENT-DOCTRINE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(fail === 0 ? 0 : 1)
