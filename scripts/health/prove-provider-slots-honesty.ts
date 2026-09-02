#!/usr/bin/env bun
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

const providerFiles = ['src/utils/router/providers/openai.ts', 'src/utils/router/providers/zai.ts']
const emitted = new Set<string>()
for (const f of providerFiles) {
  const src = readFileSync(join(ROOT, f), 'utf8')
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
