#!/usr/bin/env bun
// ============================================================================
//  scripts/model-policy/prove-model-policy-surfaces.ts — §4/§5/§9.13
//
//  Structural truths on the operator-facing surfaces + the source census:
//    · every default projection ROUTES through the one decision (no re-derive)
//    · the picker dedup law (no two rows resolving to the same model)
//    · the stale product law is absent ('everything Opus' etc.)
//  Ambient-safe: source-text checks + pure-function drives only.
//
//  Run: ~/.bun/bin/bun run scripts/model-policy/prove-model-policy-surfaces.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolvesToExistingOption,
  type ModelOption,
} from '../../src/utils/model/modelOptions.js'

const root = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const src = (p: string): string => readFileSync(join(root, p), 'utf8')

console.log('============================================================')
console.log(' model-policy — surface + census proofs')
console.log('============================================================')

console.log('\n§3/§9.13 one decision, no re-derivation (source census)')
{
  const model = src('src/utils/model/model.ts')
  const between = (s: string, a: string, b: string): string => {
    const i = s.indexOf(a)
    const j = s.indexOf(b, i)
    return i >= 0 && j > i ? s.slice(i, j) : ''
  }
  check(
    'getDefaultMainLoopModelSetting routes through the ONE computed default (the provider of the most recent sign-in)',
    between(model, 'export function getDefaultMainLoopModelSetting', '\n}').includes('computedDefault()') &&
      !model.includes('applyDefaultProviderRung') &&
      !model.includes('credentiallessGptDefault'),
  )
  check(
    'getBestModel routes through frontierOperatorDecision',
    between(model, 'export function getBestModel', '\n}').includes('frontierOperatorDecision()'),
  )
  check(
    'isFableAvailable is a projection of the decision',
    between(model, 'export function isFableAvailable', '\n}').includes('frontierOperatorDecision()'),
  )
  check(
    'the Default-row description and the /model label project the computed default',
    between(model, 'export function getDefaultModelDescription', '\n}').includes('computedDefault()') &&
      between(model, 'export function renderDefaultModelLabel', '\n}').includes('computedDefault()'),
  )
  check(
    "the stale 'everything Opus' product law is GONE from model.ts",
    !model.includes("'everything Opus'") && !model.includes('must default to Opus'),
  )
  const policy = src('src/utils/model/frontierPolicy.ts')
  check(
    'the policy is the ONE owner: pure core + live gatherer + no network import',
    policy.includes('export function evaluateFrontierDecision') &&
      policy.includes('export function gatherFrontierFacts') &&
      !/axios|fetch\(/.test(policy),
  )
  const doctor = src('src/utils/healthReport.ts')
  check(
    "/doctor's Default model row projects the computed default, the first-party decision as its detail",
    doctor.includes("id: 'frontier'") && doctor.includes('computedDefault()') && doctor.includes('frontierOperatorDecision()'),
  )
  const policySrc2 = src('src/utils/model/frontierPolicy.ts')
  check(
    'the frontier decision carries no registration table — the built-in candidate over operator signals only',
    !policySrc2.includes('FrontierCatalogCandidate') && !policySrc2.includes('futureModelCatalog'),
  )
}

console.log('\n§4 picker: pin row + fallback row + dedup law')
{
  const options = src('src/utils/model/modelOptions.ts')
  check(
    'the Fable row is an ORDINARY tier row — never gated on the decision',
    (options.match(/rows\.push\(getFableOption\(\)\)/g) ?? []).length === 2 &&
      !/if \(isFableAvailable\(\)\) \{\s*rows\.push\(getFableOption\(\)\)/.test(options),
  )
  const fableRowBody = ((): string => {
    const start = options.indexOf('function getFableOption')
    if (start === -1) return ''
    const end = options.indexOf('\n}', start)
    return end === -1 ? '' : options.slice(start, end)
  })()
  check(
    'the decision no longer touches the Fable row (neutrality ruling: model rows carry EMPTY descriptions; the decision projects only through the Default row and the Opus fallback)',
    fableRowBody.includes("description: ''") && !fableRowBody.includes('isFableAvailable'),
  )
  check(
    'Opus stays an immediately-available explicit choice on frontier profiles (gated on the decision)',
    /if \(isFableAvailable\(\)\) \{\s*rows\.push\(getOpusFrontierFallbackOption\(\)\)/.test(options),
  )
  check(
    'no synthesized frontier literal rides after the allowlist (the retired 9b special case)',
    !options.includes("value: 'claude-fable-5'"),
  )
  const rows: ModelOption[] = [
    { value: null, label: 'Default (recommended)', description: 'x' },
    { value: 'fable[1m]', label: 'Fable 5', description: 'x' },
    { value: 'opus[1m]', label: 'Opus', description: 'x' },
  ]
  check(
    "dedup: a resumed literal 'claude-fable-5[1m]' resolves to the existing fable[1m] row",
    resolvesToExistingOption(rows, 'claude-fable-5[1m]') === true,
  )
  check(
    'dedup: a distinct model is NOT deduped',
    resolvesToExistingOption(rows, 'claude-sonnet-5') === false,
  )
  check(
    'dedup: router sentinels are never resolved',
    resolvesToExistingOption(rows, '__hermes_scribe_router__') === false &&
      resolvesToExistingOption(rows, 'coming-soon:claude-fable-6') === false,
  )
}

console.log('\n§6 role-boundary repairs (recon findings)')
{
  const teammate = src('src/utils/swarm/teammateModel.ts')
  check(
    'teammate fallback follows the foreground default (the Opus-4.6 accidental universal is gone)',
    teammate.includes('getDefaultMainLoopModel()') && !teammate.includes('CLAUDE_OPUS_4_6_CONFIG'),
  )
  const caps = src('src/utils/model/capabilities.ts')
  check(
    'auto-mode gate deliberately admits the fable canonical (frontier default keeps auto mode)',
    caps.includes("m === 'claude-fable-5'"),
  )
  const autopilot = src('src/utils/autopilot/autopilotGates.ts')
  check(
    'the autopilot default allowlist includes the frontier tier (stale economics rationale gone)',
    autopilot.includes("['opus', 'sonnet', 'fable', 'fable51']") && !autopilot.includes('usage-credit-metered'),
  )
}

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ model-policy surface + census proofs: all checks pass')
