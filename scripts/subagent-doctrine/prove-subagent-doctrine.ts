#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { buildSubagentMercurySections } from '../../src/constants/subagentDoctrine.js'
import { MERCURY_IDENTITY_FLOOR } from '../../src/prompt/mercuryContract.js'
import { VERIFICATION_AGENT } from '../../src/tools/AgentTool/built-in/verificationAgent.js'
import { MERCURY_SCOUT_AGENT } from '../../src/tools/AgentTool/built-in/mercuryScoutAgent.js'
import { MERCURY_ARCHITECT_AGENT } from '../../src/tools/AgentTool/built-in/mercuryArchitectAgent.js'

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

const GP = { agentType: 'mercury-general' }
const EXEMPT = ['mercury-verifier', 'mercury-scout', 'mercury-architect', 'mercury-reviewer', 'workflow-subagent']
const NORMAL_MARK = 'You are a subagent OF Mercury'
const CARD_MARK = /^## .*experience cards/im
const GATE_CLAUSE = 'bypass a safety, permission, approval, or capability gate'
const join = (a: string[]) => a.join('\n')

console.log('============================================================')
console.log(' Subagent doctrine layer — stamp-gated proof')
console.log('============================================================')

section('(a) bare stamp ⇒ SAME sections (stamp-independence)')
setStamp(false)
const gpStock = JSON.stringify(buildSubagentMercurySections({ agentDefinition: GP }))
const exemptStock = JSON.stringify(buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-verifier' } }))
setStamp(true)
check('mercury-general: bare-stamped === full-stamped', gpStock === JSON.stringify(buildSubagentMercurySections({ agentDefinition: GP })))
check('exempt agent: bare-stamped === full-stamped', exemptStock === JSON.stringify(buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-verifier' } })))

section('(b) stamped ⇒ floor leads, the ONE NORMAL doctrine')
setStamp(true)
delete process.env.MERCURY_EXPERIENCE_CARDS
{
  const s = buildSubagentMercurySections({ agentDefinition: GP })
  check('returns a non-empty section list', s.length >= 2, `len=${s.length}`)
  check('section[0] is the identity floor (LEADS)', s[0] === MERCURY_IDENTITY_FLOOR)
  check('NORMAL doctrine present', join(s).includes(NORMAL_MARK) && join(s).includes('<subagent-doctrine>'))
}

section('(c) the 4 fixed-output agents get the SAME NORMAL doctrine as mercury-general')
for (const a of EXEMPT) {
  const s = join(buildSubagentMercurySections({ agentDefinition: { agentType: a } }))
  check(`${a}: NORMAL doctrine (one register for every agent)`, s.includes(NORMAL_MARK) && s.includes('<subagent-doctrine>'))
}

section('(d) C14: exempt Set DERIVED from fixedOutputContract (membership, not a string literal)')
delete process.env.MERCURY_EXPERIENCE_CARDS
{
  for (const def of [VERIFICATION_AGENT, MERCURY_SCOUT_AGENT, MERCURY_ARCHITECT_AGENT]) {
    check(`${def.agentType}: def carries fixedOutputContract:true`, def.fixedOutputContract === true)
    const s = join(buildSubagentMercurySections({ agentDefinition: { agentType: def.agentType } }))
    check(`${def.agentType}: agentType ∈ derived exempt Set (card doctrine omitted)`, !CARD_MARK.test(s) && s.includes('<subagent-doctrine>'))
  }
  check("'workflow-subagent' literal ∈ derived exempt Set (card doctrine omitted)", !CARD_MARK.test(join(buildSubagentMercurySections({ agentDefinition: { agentType: 'workflow-subagent' } }))))
  check('a non-flagged agent (mercury-general) is NOT exempt (keeps the card doctrine)', CARD_MARK.test(join(buildSubagentMercurySections({ agentDefinition: GP }))))
  check('a made-up agentType is NOT exempt (no drift to over-exempting)', CARD_MARK.test(join(buildSubagentMercurySections({ agentDefinition: { agentType: 'not-a-real-fixed-output-agent' } }))))
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

section('(e) experience-card doctrine — gated on cards-enabled + omitted for exempt agents')
delete process.env.MERCURY_EXPERIENCE_CARDS
check('cards ON: mercury-general INCLUDES the card doctrine', CARD_MARK.test(join(buildSubagentMercurySections({ agentDefinition: GP }))))
for (const a of EXEMPT) {
  check(`${a}: card doctrine OMITTED (fixed-output/read-only worker)`, !CARD_MARK.test(join(buildSubagentMercurySections({ agentDefinition: { agentType: a } }))))
}
process.env.MERCURY_EXPERIENCE_CARDS = '0'
check('cards OFF (=0): mercury-general drops the card doctrine', !CARD_MARK.test(join(buildSubagentMercurySections({ agentDefinition: GP }))))
delete process.env.MERCURY_EXPERIENCE_CARDS

section('(e2) API-currency: doctrine line for ALL agents + env-block currency note')
{
  const CURRENCY_MARK = 'provider-apis'
  check('mercury-general carries the API-currency line', join(buildSubagentMercurySections({ agentDefinition: GP })).includes(CURRENCY_MARK))
  for (const a of EXEMPT) {
    check(`${a}: carries the API-currency line (fact line, not a register)`, join(buildSubagentMercurySections({ agentDefinition: { agentType: a } })).includes(CURRENCY_MARK))
  }
  check('the line names the supersession (claude-api → provider-apis)', join(buildSubagentMercurySections({ agentDefinition: GP })).includes('claude-api'))
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
