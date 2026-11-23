#!/usr/bin/env bun
import {
  resolvesToExistingOption,
  type ModelOption,
} from '../../src/models/catalogue/modelOptions.js'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' model-policy — surface + census proofs')
console.log('============================================================')

console.log('\n§3/§9.13 one decision, no re-derivation (source census)')
{
  const { settingsChecks } = await import('../../src/platform/health/sections/settings.ts')
  const computed = await import('../../src/models/catalogue/computedDefault.ts')
  const frontier = await import('../../src/models/catalogue/frontierPolicy.ts')
  const { providerDisplayName } = await import('../../src/models/roads/routeLaw.ts')
  const frontierSays = await settingsChecks().find(row => row.id === 'frontier')?.run()
  check(
    "/health's Default model row projects the computed default, the first-party decision as its detail",
    frontierSays?.evidence.includes(computed.describeComputedDefault(computed.computedDefault(), providerDisplayName)) === true && frontierSays.detail?.startsWith(`first-party gating: ${frontier.describeFrontierDecision(frontier.frontierOperatorDecision())} — candidates: `) === true,
    `${frontierSays?.evidence} · ${frontierSays?.detail} - the frontier row of settingsChecks (src/platform/health/sections/settings.ts) must show describeComputedDefault of computedDefault (src/models/catalogue/computedDefault.ts) as evidence and describeFrontierDecision (src/models/catalogue/frontierPolicy.ts) in its detail`,
  )
}

console.log('\n§4 picker: pin row + fallback row + dedup law')
{
  const rows: ModelOption[] = [
    { value: 'fable[1m]', label: 'Fable 5.2', description: 'x' },
    { value: 'opus[1m]', label: 'Opus', description: 'x' },
  ]
  check(
    "dedup: a resumed literal 'claude-fable-5-2[1m]' resolves to the existing fable[1m] row",
    resolvesToExistingOption(rows, 'claude-fable-5-2[1m]') === true,
    'resolvesToExistingOption (src/models/catalogue/modelOptions.ts) must map this literal to the fable[1m] row',
  )
  check(
    "dedup: the previous generations' literals 'claude-fable-5-1[1m]' and 'claude-fable-5[1m]' are NOT folded into the fable[1m] row",
    resolvesToExistingOption(rows, 'claude-fable-5-1[1m]') === false && resolvesToExistingOption(rows, 'claude-fable-5[1m]') === false,
    'resolvesToExistingOption (src/models/catalogue/modelOptions.ts) must map only the current fable literal to the fable[1m] row',
  )
  check(
    'dedup: a distinct model is NOT deduped',
    resolvesToExistingOption(rows, 'claude-sonnet-5') === false,
    'resolvesToExistingOption (src/models/catalogue/modelOptions.ts) must return false for a model with no existing row',
  )
  check(
    'dedup: sentinel values are never resolved',
    resolvesToExistingOption(rows, '__mercury_test_sentinel__') === false &&
      resolvesToExistingOption(rows, 'coming-soon:claude-fable-6') === false,
    'resolvesToExistingOption (src/models/catalogue/modelOptions.ts) must return false for sentinel values',
  )
}


console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ model-policy surface + census proofs: all checks pass')
