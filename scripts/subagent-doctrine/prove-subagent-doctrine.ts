#!/usr/bin/env bun
// ============================================================================
//  scripts/subagent-doctrine/prove-subagent-doctrine.ts
//  PROOF: the stamp-gated SUBAGENT identity+operating-doctrine layer
//  (src/constants/subagentDoctrine.ts) — OFF byte-identical, floor leads, the
//  normal/fable variants + the four fable-exemptions, the autoadaptive card
//  gating+exemption, and the safety floor never weakened. Exercised against the
//  REAL module (no reimpl). globalThis.MACRO stamp-sim (the build stamp reads
//  MACRO.VERSION at runtime); mercuryContract.ts loads natively under bun-run
//  (see scripts/substrate/prove-wrapper.ts) — repo-owned source since.
//  The workflow-agent builders live in agentHooks.ts (a feature()-macro module,
//  not bun-loadable) — their contract preservation is covered by dist-grep in
//  run-all.sh.
// ============================================================================

import { readFileSync } from 'node:fs'
import { buildSubagentMercurySections } from '../../src/constants/subagentDoctrine.js'
import { MERCURY_IDENTITY_FLOOR } from '../../src/prompt/mercuryContract.js'
// value-import the same three built-in defs the derived exempt Set is built from. That
// this import (and subagentDoctrine's) loads under bun-run IS the loadability guarantee.
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

const GP = { agentType: 'general-purpose' }
const EXEMPT = ['verification', 'mercury-scout', 'mercury-architect', 'workflow-subagent']
const NORMAL_MARK = 'You are a subagent OF Mercury'
const CARD_MARK = /^## .*experience cards/im
const GATE_CLAUSE = 'bypass a safety, permission, approval, or capability gate'
const join = (a: string[]) => a.join('\n')

console.log('============================================================')
console.log(' Subagent doctrine layer — stamp-gated proof')
console.log('============================================================')

// ── (a) sections are stamp-independent (equality probes against the stamped
// outputs in the same state).
section('(a) bare stamp ⇒ SAME sections (stamp-independence)')
setStamp(false)
const gpStock = JSON.stringify(buildSubagentMercurySections({ agentDefinition: GP }))
const exemptStock = JSON.stringify(buildSubagentMercurySections({ agentDefinition: { agentType: 'verification' } }))
setStamp(true)
check('general-purpose: bare-stamped === full-stamped', gpStock === JSON.stringify(buildSubagentMercurySections({ agentDefinition: GP })))
check('exempt agent: bare-stamped === full-stamped', exemptStock === JSON.stringify(buildSubagentMercurySections({ agentDefinition: { agentType: 'verification' } })))

// ── (b) ON: floor LEADS + NORMAL doctrine ─────────────────────────────────────
section('(b) ON (fork) ⇒ floor leads, the ONE NORMAL doctrine')
setStamp(true)
delete process.env.MERCURY_EXPERIENCE_CARDS
{
  const s = buildSubagentMercurySections({ agentDefinition: GP })
  check('returns a non-empty section list', s.length >= 2, `len=${s.length}`)
  check('section[0] is the identity floor (LEADS)', s[0] === MERCURY_IDENTITY_FLOOR)
  check('NORMAL doctrine present', join(s).includes(NORMAL_MARK) && join(s).includes('<subagent-doctrine>'))
}

// ── (c) every agent gets the same operating register ──────────────────────────
section('(c) the 4 fixed-output agents get the SAME NORMAL doctrine as general-purpose')
for (const a of EXEMPT) {
  const s = join(buildSubagentMercurySections({ agentDefinition: { agentType: a } }))
  check(`${a}: NORMAL doctrine (one register for every agent)`, s.includes(NORMAL_MARK) && s.includes('<subagent-doctrine>'))
}

// ── (d): the exempt Set is DERIVED from fixedOutputContract ───────────────
section('(d) C14: exempt Set DERIVED from fixedOutputContract (membership, not a string literal)')
delete process.env.MERCURY_EXPERIENCE_CARDS // cards ON: the exemption's observable is the omitted card doctrine
{
  // Each value-importable def carries the flag, and its agentType lands in the derived Set —
  // proved BEHAVIORALLY (the card-write doctrine is omitted for members). A mis-derive that
  // dropped a def would push the card doctrine onto a fixed-output return: the failure #14 guards.
  for (const def of [VERIFICATION_AGENT, MERCURY_SCOUT_AGENT, MERCURY_ARCHITECT_AGENT]) {
    check(`${def.agentType}: def carries fixedOutputContract:true`, def.fixedOutputContract === true)
    const s = join(buildSubagentMercurySections({ agentDefinition: { agentType: def.agentType } }))
    check(`${def.agentType}: agentType ∈ derived exempt Set (card doctrine omitted)`, !CARD_MARK.test(s) && s.includes('<subagent-doctrine>'))
  }
  // 'workflow-subagent' is appended as a literal (agentHooks.ts is bun:bundle-unloadable) —
  // behavioral membership check + a source assertion below.
  check("'workflow-subagent' literal ∈ derived exempt Set (card doctrine omitted)", !CARD_MARK.test(join(buildSubagentMercurySections({ agentDefinition: { agentType: 'workflow-subagent' } }))))
  // CONVERSE — the derive is not accidentally exempting everyone: a non-flagged agent keeps
  // the card doctrine, and a made-up agentType is NOT exempt (the Set is EXACTLY flagged-defs + literal).
  check('a non-flagged agent (general-purpose) is NOT exempt (keeps the card doctrine)', CARD_MARK.test(join(buildSubagentMercurySections({ agentDefinition: GP }))))
  check('a made-up agentType is NOT exempt (no drift to over-exempting)', CARD_MARK.test(join(buildSubagentMercurySections({ agentDefinition: { agentType: 'not-a-real-fixed-output-agent' } }))))
}

// ── (d2) source: the Set is derived, and WORKFLOW_SUBAGENT_DEF is flagged ───
section('(d2) C14 source — derived Set (not a string literal) + WORKFLOW_SUBAGENT_DEF flagged')
{
  const sd = read('../../src/constants/subagentDoctrine.ts')
  check('exempt Set is DERIVED via .filter(d => d.fixedOutputContract)', sd.includes('.filter(d => d.fixedOutputContract)') && sd.includes(".concat('workflow-subagent')"))
  check('the prior hard-coded string Set is GONE', !/new Set<string>\(\[\s*'verification',\s*'Explore',\s*'Plan',\s*'workflow-subagent',?\s*\]\)/.test(sd))
  const ah = read('../../src/tools/WorkflowTool/agentHooks.ts')
  check('WORKFLOW_SUBAGENT_DEF carries fixedOutputContract: true', /WORKFLOW_SUBAGENT_DEF = \{[\s\S]{0,900}fixedOutputContract: true/.test(ah))
  const la = read('../../src/tools/AgentTool/loadAgentsDir.ts')
  check('BaseAgentDefinition declares fixedOutputContract?: boolean', la.includes('fixedOutputContract?: boolean'))
}

// ── (e) autoadaptive card doctrine: gating + exemption ────────────────────────
section('(e) experience-card doctrine — gated on cards-enabled + omitted for exempt agents')
delete process.env.MERCURY_EXPERIENCE_CARDS // fork default ⇒ cards ON
check('cards ON: general-purpose INCLUDES the card doctrine', CARD_MARK.test(join(buildSubagentMercurySections({ agentDefinition: GP }))))
for (const a of EXEMPT) {
  check(`${a}: card doctrine OMITTED (fixed-output/read-only worker)`, !CARD_MARK.test(join(buildSubagentMercurySections({ agentDefinition: { agentType: a } }))))
}
process.env.MERCURY_EXPERIENCE_CARDS = '0'
check('cards OFF (=0): general-purpose drops the card doctrine', !CARD_MARK.test(join(buildSubagentMercurySections({ agentDefinition: GP }))))
delete process.env.MERCURY_EXPERIENCE_CARDS

// ── (e2) API-currency routing (task #9): every agent — exempt included — is
// routed to the bundled provider-apis skill for provider-API work, and the
// SUBAGENT env block (computeEnvInfo) carries the model-currency note the
// main session already had (a spawned agent without it answers model-ID
// questions from stale training priors).
section('(e2) API-currency: doctrine line for ALL agents + env-block currency note')
{
  const CURRENCY_MARK = 'provider-apis'
  check('general-purpose carries the API-currency line', join(buildSubagentMercurySections({ agentDefinition: GP })).includes(CURRENCY_MARK))
  for (const a of EXEMPT) {
    check(`${a}: carries the API-currency line (fact line, not a register)`, join(buildSubagentMercurySections({ agentDefinition: { agentType: a } })).includes(CURRENCY_MARK))
  }
  check('the line names the supersession (claude-api → provider-apis)', join(buildSubagentMercurySections({ agentDefinition: GP })).includes('claude-api'))
  // Source-lock: the subagent env block (computeEnvInfo — the ONLY caller is
  // enhanceSystemPromptWithEnvDetails, the subagent path) interpolates the
  // shared MODEL_CURRENCY_NOTE — the NEUTRAL live-catalogue rule, one
  // content for every family.
  const pr = read('../../src/constants/prompts.ts')
  const envFn = pr.slice(pr.indexOf('export async function computeEnvInfo'), pr.indexOf('export async function computeSimpleEnvInfo'))
  check('computeEnvInfo interpolates MODEL_CURRENCY_NOTE', envFn.includes('${MODEL_CURRENCY_NOTE}'))
  check('…for EVERY family (no route gate on the currency rule)', !envFn.includes('isAnthropicRoutedModelId'))
  // the main session carries the note as the dedicated 'model_currency'
  // section — same const, one owner, no twin literal.
  check('the model_currency section shares the same const (no drift-prone twin literal)', pr.includes('function getModelCurrencySection(): string {\n  return MODEL_CURRENCY_NOTE\n}'))
  check('MODEL_CURRENCY_NOTE is the neutral rule — no vendor model list hardcoded', /MODEL_CURRENCY_NOTE = `Model currency:/.test(pr) && !/MODEL_CURRENCY_NOTE = `[^`]*claude-/.test(pr))
}

// ── (f) the safety floor is never weakened ─────────────────────────────────────
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
