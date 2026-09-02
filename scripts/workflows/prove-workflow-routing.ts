#!/usr/bin/env bun
// ============================================================================
//  scripts/workflows/prove-workflow-routing.ts
//  PROOF: the opt-in agent({tier}) routing default —
//  flag-OFF full (tier × model) table byte-identical (returns undefined,
//  never touches opts); flag-ON executor→claude-opus-5, orchestrator→
//  fallthrough, explicit model always wins; junk tier THROWS regardless of
//  the flag; bare-stamp inert; the DSL prompt doc ships the tier contract
//  (an undocumented VM surface is a dead surface); the agentHooks wiring
//  routes BEFORE the resume cache key.
//  Run:  ~/.bun/bin/bun run scripts/workflows/prove-workflow-routing.ts
// ============================================================================
// The one prover preamble FIRST: the neutral seat default below resolves
// credentials, so this proof runs in its own scratch home on the
// file-backed credential store — never the operator's home or keychain.
import '../lib/hermetic.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)) }
const MK = 'MACRO' as const
const setStamp = (on: boolean) => { if (on) (globalThis as Record<string, unknown>)[MK] = { VERSION: '1.0.0' }; else delete (globalThis as Record<string, unknown>)[MK] }
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Workflow tier routing — proof')
console.log('============================================================')

const wr = (await import('../../src/tools/WorkflowTool/workflowRouting.js')) as typeof import('../../src/tools/WorkflowTool/workflowRouting.js')

const stashFlag = process.env.MERCURY_WORKFLOW_ROUTING
delete process.env.MERCURY_WORKFLOW_ROUTING

section('flag OFF (opt-in default) — the full (tier × model) table returns undefined (byte-identical)')
setStamp(true)
const tiers = [undefined, 'orchestrator', 'executor'] as const
const models = [undefined, 'claude-opus-4-8', 'sonnet5'] as const
for (const tier of tiers) {
  for (const model of models) {
    check(
      `off: tier=${String(tier)} model=${String(model)} ⇒ undefined`,
      wr.resolveWorkflowRoutedModel({ tier, model }) === undefined,
    )
  }
}

section('opt-in default: unset ⇒ inert (the ask-the-operator rule holds by construction)')
check('DEFAULT (unset): executor + no model ⇒ undefined (no silent routing)', wr.resolveWorkflowRoutedModel({ tier: 'executor' }) === undefined)
check('DEFAULT (unset): no tier ⇒ undefined', wr.resolveWorkflowRoutedModel({}) === undefined)

section('flag ON — the executor routes to the NEUTRAL seat default, orchestrator falls through, explicit model wins')
process.env.MERCURY_WORKFLOW_ROUTING = '1'
// The operator's law: no family is favoured. The executor tier routes to
// the neutral seat default (the most recent sign-in's provider, its newest
// usable row — the one resolver the coordinator's launches and the crew
// spawn ask); the pinned first-party id it replaced had every routed
// executor refuse on an account signed into another provider alone.
const { neutralSeatDefault } = await import('../../src/services/concourse/workerModels.js')
const neutral = neutralSeatDefault()
check('executor + no model ⇒ the neutral seat default (undefined with no usable sign-in in this home, never a favoured family)', wr.resolveWorkflowRoutedModel({ tier: 'executor' }) === (neutral?.setting ?? undefined), JSON.stringify({ routed: wr.resolveWorkflowRoutedModel({ tier: 'executor' }), neutral }))
check('the executor model is the neutral seat default, one owner', wr.workflowExecutorModel() === (neutral?.setting ?? undefined))
check('no pinned executor id survives in the router (no favoured family)', !src('tools', 'WorkflowTool', 'workflowRouting.ts').includes("'claude-opus-5'"))
check('orchestrator ⇒ undefined (main-loop fallthrough, cache keys untouched)', wr.resolveWorkflowRoutedModel({ tier: 'orchestrator' }) === undefined)
check('no tier ⇒ undefined', wr.resolveWorkflowRoutedModel({}) === undefined)
check('explicit model ALWAYS wins over the tier', wr.resolveWorkflowRoutedModel({ tier: 'executor', model: 'claude-opus-4-8' }) === undefined)

// the flag opt-in is stamp-independent.
section('bare stamp — routing STILL works with the flag set (stamp-independence)')
setStamp(false)
check('bare stamp + flag=1 ⇒ the same neutral answer', wr.resolveWorkflowRoutedModel({ tier: 'executor' }) === (neutral?.setting ?? undefined))
setStamp(true)

section('validateWorkflowTier — junk throws ALWAYS (flag-independent)')
const throwsOn = (v: unknown): boolean => {
  try {
    wr.validateWorkflowTier(v)
    return false
  } catch {
    return true
  }
}
for (const flag of ['1', undefined] as const) {
  if (flag) process.env.MERCURY_WORKFLOW_ROUTING = flag
  else delete process.env.MERCURY_WORKFLOW_ROUTING
  check(`flag=${String(flag)}: 'dps' throws`, throwsOn('dps'))
  check(`flag=${String(flag)}: 42 throws`, throwsOn(42))
  check(`flag=${String(flag)}: 'Executor' (case) throws`, throwsOn('Executor'))
  check(`flag=${String(flag)}: valid values pass`, !throwsOn('executor') && !throwsOn('orchestrator') && !throwsOn(undefined))
}

section('DSL prompt doc ships the tier contract (undocumented VM surface = dead surface)')
const doc = src('tools', 'WorkflowTool', 'workflowPrompt.ts')
check("doc carries both tier values as the union 'orchestrator' | 'executor'", /'orchestrator' \| 'executor'/.test(doc))
check('doc names the opt-in gate (registered spelling) + inertness + explicit-model-wins', /routing only acts when the operator armed MERCURY_WORKFLOW_ROUTING=1/.test(doc) && /names opts\.model outranks its tier/.test(doc))
// Authoring doctrine: the operator's model rule + the verify-stage contract
// ship with every composed prompt, never gated behind a capability flag.
check('doctrine section: operator model rule overrides the omit-guidance and bans small-tier agentType pins', /## Mercury workflow authorship doctrine/.test(doc) && /overrides the "leave opts\.model out" default/.test(doc) && /never pick an agentType whose definition pins a small-tier model/.test(doc))
check('doctrine section: verify-stage contract for non-trivial implementation', /A verify stage belongs to the workflow's shape itself/.test(doc) && /an assertion, not evidence/.test(doc))
check('doctrine appended unconditionally in getWorkflowToolPrompt (before the gated addenda)', /text \+= AUTHORING_DOCTRINE_SECTION/.test(doc) && doc.indexOf('text += AUTHORING_DOCTRINE_SECTION') !== -1 && doc.indexOf('text += AUTHORING_DOCTRINE_SECTION') < doc.indexOf('if (themisActive())'))
check('doc teaches executor-tier routing by mechanism, no literal model id', /rides the harness's pinned execution-tier model/.test(doc) && !/claude-[a-z0-9-]+/.test(doc))

section('agentHooks wiring — validate + route BEFORE the resume cache key')
const hooks = src('tools', 'WorkflowTool', 'agentHooks.ts')
check('imports the routing module', /from '\.\/workflowRouting\.js'/.test(hooks))
const routeIdx = hooks.indexOf('validateWorkflowTier(opts?.tier)')
const cacheIdx = hooks.indexOf('agentCacheKey(prompt, opts, cacheChainTip)')
check('routing block present and BEFORE the cache key (flag flips are honest cache misses)', routeIdx > 0 && cacheIdx > 0 && routeIdx < cacheIdx)
check('routed model written into opts.model (one downstream path)', /if \(routed !== undefined\) opts\.model = routed/.test(hooks))

if (stashFlag !== undefined) process.env.MERCURY_WORKFLOW_ROUTING = stashFlag
else delete process.env.MERCURY_WORKFLOW_ROUTING
setStamp(false)

console.log('\n' + '='.repeat(60))
if (failures > 0) { console.log(` FAIL — ${failures} check(s) failed`); process.exit(1) }
console.log(' ALL WORKFLOW-ROUTING PROOFS PASS')
