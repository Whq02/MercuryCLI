#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-provider-slots-honesty.ts — the Provider-slots health
//  row accepts EVERY honest engine-unavailable state (operator-reported RED,
// an armed engine whose account momentarily fails to resolve
//  reports 'no-account:openai' — an honest stable state the row must class
//  ok, never fail. The law: every unavailable reason the providers can emit
//  while engines are ON starts with a code in the row's accepted list.
//  + the AUTH section is provider-neutral BY
//  CONSTRUCTION: its rows enumerate the provider catalogue — never a
//  hand-kept provider list.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' Provider slots — honest-unavailable acceptance law')
console.log('============================================================')

const healthSrc = readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8')
const listMatch = healthSrc.match(/ENGINE_UNAVAILABLE_CODES = \[([^\]]+)\]/)
check('the accepted-code list exists', listMatch !== null)
const accepted = (listMatch?.[1] ?? '')
  .split(',')
  .map(s => s.trim().replace(/^'|'$/g, ''))
  .filter(Boolean)

// Every engines-ON unavailable reason literal the providers can emit.
const providerFiles = ['src/utils/router/providers/openai.ts', 'src/utils/router/providers/zai.ts']
const emitted = new Set<string>()
for (const f of providerFiles) {
  const src = readFileSync(join(ROOT, f), 'utf8')
  // reasons the adapters emit (credential truth — engines are default-on).
  for (const m of src.matchAll(/reason: '([a-z-]+:[a-z-]+)'/g)) emitted.add(m[1]!)
}
check('provider reason literals found', emitted.size >= 2, [...emitted].join(', '))
for (const reason of emitted) {
  check(
    `'${reason}' is accepted as an honest unavailable state`,
    accepted.some(code => reason.startsWith(code)),
    `accepted codes: ${accepted.join(' ')}`,
  )
}
check("the defect-class code 'no-account:' is in the list", accepted.includes('no-account:'))

// THE SEAT LAW:
// decision #6 makes resolve('gpt') return the qualified LIVE candidate
// when an account + a qualified catalogue exist — a LIVE gpt scribe session
// is exactly that state, and the old blanket `resolve === null` clause
// painted it as "provider honesty broke". The row must accept a
// correctly-labeled engine ref (its own provider + class) and refuse only a
// mislabel.
check(
  'the row accepts a correctly-labeled resolved gpt ref',
  /gptRef === null \|\| \(gptRef\.provider === 'openai' && gptRef\.modelClass === 'gpt'\)/.test(healthSrc),
)
check(
  'the glm class carries the same own-engine label law',
  /glmRef === null \|\| \(glmRef\.provider === 'zai' && glmRef\.modelClass === 'glm'\)/.test(healthSrc),
)
check(
  'the stale blanket seats-stay-Anthropic clause is gone',
  !/seatsStayAnthropic/.test(healthSrc),
)

// THE NEUTRAL-AUTH CONSTRUCTION LAW: the AUTH
// rows are BUILT from the provider catalogue snapshot — the row ids derive
// from the enumerated provider id, so a future adapter joins the section
// without an edit here, and no hand-kept provider list can drift.
check(
  'AUTH rows enumerate the catalogue (buildRouterModelSnapshot inside providerAuthChecks)',
  /function providerAuthChecks\(\)[\s\S]{0,200}buildRouterModelSnapshot\(\)/.test(healthSrc),
)
check(
  'AUTH row ids derive from the enumerated provider id (never a literal row list)',
  healthSrc.includes('id: `auth-${provider.id}`'),
)
check(
  'the no-network-probe law is stated on present credentials',
  healthSrc.includes('validity untested: no network probe by design'),
)

console.log(failures === 0 ? '\n✅ provider-slots honesty law holds' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
