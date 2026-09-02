#!/usr/bin/env bun
// ============================================================================
//  scripts/harness-profiles/prove-ch4-context-application.ts — the CH-4 context-axis
//  application (CH-16/CH-38): the ONE real owner mapping the harness estate
//  applies today.
//    §A precedence at the owner: the explicit MERCURY_CONTEXT_SELECTION flag
//       OUTRANKS the profile request (operator choice wins); unset+null ⇒
//       preserve-all; unknown values degrade.
//    §B the application helper: off ⇒ null (zero resolver work); armed
//       accepted default requests the IDENTITY state ('preserve-all' — the
//       CH-15 certificate extends through the axis); armed + candidate
//       session pin requests 'bounded-optional' (the profile request
//       actually reaches the owner).
//    §C the REAL builder end-to-end: the threaded request flips the plan's
//       selection policy; with NO budget bounded-optional excludes NOTHING
//       (the owner's honest no-budget state — dependency closure and
//       canonical history untouched, CH-38); apply ≡ inspect on the
//       decision digest under the candidate request (the parity oracle
//       spans the harness input).
//
//  Env hygiene: fixture config home outside the repo; flags pinned per leg;
//  test-mode config (the boot gate).
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'harness-ch4-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HARNESS_PROFILE
delete process.env.MERCURY_HARNESS_PROFILE_PIN
delete process.env.MERCURY_CONTEXT_SELECTION

const { resolveSelectionPolicy } = await import('../../src/services/run/contextSelection.ts')
const { harnessContextPolicyRequest, setHarnessSessionPin } = await import(
  '../../src/services/mission/harnessApplication.ts'
)
const planMod = await import('../../src/services/run/requestContextPlan.ts')
const ok = await import('../../src/services/run/ownerKey.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('§A precedence at the owner (operator choice wins)')
check('§A unset flag + null request ⇒ preserve-all', resolveSelectionPolicy(null) === 'preserve-all')
check('§A unset flag + no request arg ⇒ preserve-all (existing callers unchanged)', resolveSelectionPolicy() === 'preserve-all')
check("§A the profile request reaches the owner when the flag is silent", resolveSelectionPolicy('bounded-optional') === 'bounded-optional')
process.env.MERCURY_CONTEXT_SELECTION = 'preserve-all'
check('§A an EXPLICIT preserve-all flag OUTRANKS the profile request', resolveSelectionPolicy('bounded-optional') === 'preserve-all')
process.env.MERCURY_CONTEXT_SELECTION = 'bounded-optional'
check('§A an explicit bounded-optional flag stands regardless of the request', resolveSelectionPolicy(null) === 'bounded-optional')
process.env.MERCURY_CONTEXT_SELECTION = 'garbage-value'
check('§A unknown flag values degrade (request may still speak)', resolveSelectionPolicy(null) === 'preserve-all' && resolveSelectionPolicy('bounded-optional') === 'bounded-optional')
delete process.env.MERCURY_CONTEXT_SELECTION

console.log('§B the application helper (harnessContextPolicyRequest)')
check('§B off ⇒ null (zero resolver work)', harnessContextPolicyRequest('claude-fable-5') === null)
process.env.MERCURY_HARNESS_PROFILE = 'on'
check("§B armed accepted default requests the IDENTITY state", harnessContextPolicyRequest('claude-fable-5') === 'preserve-all')
setHarnessSessionPin('anthropic-context-bounded')
check("§B a pin on the RETIRED candidate falls through NAMED — the request stays identity (retirement is total)", harnessContextPolicyRequest('claude-fable-5') === 'preserve-all')
setHarnessSessionPin(null)
check('§B reset returns the identity request', harnessContextPolicyRequest('claude-fable-5') === 'preserve-all')

console.log('§C the REAL builder end-to-end (CH-16 / CH-38 / C09 parity)')
const u = (n: number): string => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`
type AnyMessage = Record<string, unknown>
const msgs: AnyMessage[] = []
let n = 1
for (let i = 0; i < 12; i++) {
  msgs.push({ type: 'user', uuid: u(n++), message: { role: 'user', content: `old question ${i}` } })
  msgs.push({ type: 'assistant', uuid: u(n++), message: { role: 'assistant', content: [{ type: 'text', text: `old answer ${i}` }] } })
}
msgs.push({ type: 'user', uuid: u(n++), message: { role: 'user', content: 'the active operator request' } })
const OWNER = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'harness-ch4', lane: 'main' })
const build = (harnessContextPolicy: 'preserve-all' | 'bounded-optional' | null, mode: 'apply' | 'inspect') =>
  planMod.buildRequestContextPlan(
    {
      messages: msgs as never,
      owner: OWNER,
      querySource: 'repl_main_thread' as never,
      contentReplacementState: undefined,
      skipToolNames: new Set<string>(),
      harnessContextPolicy,
    },
    mode,
  )
const identityPlan = await build('preserve-all', 'inspect')
check('§C the identity request keeps the preserve-all policy on the plan', identityPlan.selection?.policy === 'preserve-all')
const candidatePlan = await build('bounded-optional', 'inspect')
check("§C the candidate request flips the plan's selection policy", candidatePlan.selection?.policy === 'bounded-optional')
check(
  '§C no budget ⇒ bounded-optional excludes NOTHING (the honest no-budget state; closure untouched)',
  candidatePlan.selection !== undefined &&
    candidatePlan.selection.excluded.length === 0 &&
    candidatePlan.messages.length === identityPlan.messages.length,
)
const applyPlan = await build('bounded-optional', 'apply')
const inspectPlan = await build('bounded-optional', 'inspect')
check(
  '§C apply ≡ inspect under the candidate request (the C09 parity oracle spans the harness input)',
  applyPlan.selection?.digest === inspectPlan.selection?.digest &&
    applyPlan.messages.length === inspectPlan.messages.length,
)

delete process.env.MERCURY_HARNESS_PROFILE
console.log(failures === 0 ? '\nprove-ch4-context-application: green' : `\nprove-ch4-context-application: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
