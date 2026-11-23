#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'prove-usage-listing-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_HOME = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'
process.env.MERCURY_ZAI_API_BASE = 'https://fixture.invalid/zai'
process.env.MERCURY_DEEPSEEK_API_BASE = 'https://fixture.invalid/deepseek'
process.env.MERCURY_MOONSHOT_API_BASE = 'https://fixture.invalid/moonshot/v1'
const CREDENTIAL_ENVS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'HF_TOKEN'] as const
for (const name of CREDENTIAL_ENVS) delete process.env[name]
process.env.ZAI_API_KEY = 'zai-fixture000'
process.env.DEEPSEEK_API_KEY = 'sk-deepseek-fixture000'
process.env.OPENROUTER_API_KEY = 'sk-or-fixture000'
process.env.MOONSHOT_API_KEY = 'sk-moonshot-fixture000'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const discovery = await import('../../src/models/roads/providerDiscovery.js')
const ledger = await import('../../src/models/sign-in/account-ledger/signInLedger.ts')
const { recentSignIns } = await import('../../src/models/catalogue/computedDefault.ts')
const { providerFamilyPresences } = await import('../../src/models/roads/providerUsage.ts')
const { usageSectionPlan, orderUsageSections, usageColumns } = await import('../../src/screen/settings/Usage.tsx')

const T = 1_760_000_000_000
const ids = (sections: ReadonlyArray<{ id: string }>): string[] => sections.map(s => s.id)

console.log('the /usage listing: every signed-in provider by its most recent sign-in, the shared ledger\'s order')

section('§1 timed sign-ins newest first, the untimed credential after, the absent families last in catalogue order')
{
  discovery.__resetProviderDiscoveryForTest()
  const plan = usageSectionPlan(providerFamilyPresences())
  const signedIn = plan.filter(s => s.family.credentialed).map(s => s.id).sort()
  check('the fixture home signs four families in (zai · deepseek · openrouter · moonshot)', signedIn.join(',') === 'deepseek,moonshot,openrouter,zai', signedIn.join(',') + ' — change usageSectionPlan in src/screen/settings/usage/plan.ts or providerFamilyPresences in src/models/roads/providerUsage.ts so the four fixture keys count as credentialed')
  check('the plan itself keeps catalogue order (the derivation-law provers stand)', ids(plan)[0] === 'anthropic', 'usageSectionPlan in src/screen/settings/usage/plan.ts must not reorder; ordering belongs to orderUsageSections')
  check('deepseek signs in first', ledger.recordSignIn('deepseek', 'api-key', { now: () => T + 1_000 }))
  check('zai signs in second', ledger.recordSignIn('zai', 'api-key', { now: () => T + 2_000 }))
  check('openrouter signs in last', ledger.recordSignIn('openrouter', 'oauth', { now: () => T + 3_000 }))
  check('a departed family (gemini) has a record but no credential', ledger.recordSignIn('gemini', 'oauth', { now: () => T + 9_000 }))
  const recency = recentSignIns().map(c => c.family)
  check('the shared owner orders the credentials: openrouter, zai, deepseek, then the untimed moonshot; gemini absent', recency.join(',') === 'openrouter,zai,deepseek,moonshot', recency.join(',') + ' — change recentSignIns in src/models/catalogue/computedDefault.ts: newest timed sign-in first, untimed credentials after, families without a credential dropped')
  const ordered = orderUsageSections(plan, recency)
  const absentTail = plan.filter(s => !s.family.credentialed).map(s => s.id)
  check('the listing leads with the most recent sign-in and follows the ledger', ids(ordered).slice(0, 4).join(',') === 'openrouter,zai,deepseek,moonshot', ids(ordered).join(',') + ' — change orderUsageSections in src/screen/settings/usage/plan.ts to lead with the recency list order')
  check('the absent families follow in catalogue order', ids(ordered).slice(4).join(',') === absentTail.join(','), ids(ordered).join(',') + ' — orderUsageSections in src/screen/settings/usage/plan.ts must keep non-credentialed families after the signed-in ones in plan order')
  check('the first-party family leads nothing by name — absent here, it sits in the absent tail at its catalogue position', ids(ordered)[0] !== 'anthropic' && ids(ordered).indexOf('anthropic') === 4 + absentTail.indexOf('anthropic'))
  check('every family is listed exactly once', ids(ordered).length === plan.length && new Set(ids(ordered)).size === plan.length)
}

section('§2 a later sign-in re-orders the listing')
{
  check('deepseek signs in again, later than every other', ledger.recordSignIn('deepseek', 'api-key', { now: () => T + 5_000 }))
  const ordered = orderUsageSections(usageSectionPlan(providerFamilyPresences()), recentSignIns().map(c => c.family))
  check('deepseek now leads; openrouter and zai keep their relative order; moonshot stays untimed after them', ids(ordered).slice(0, 4).join(',') === 'deepseek,openrouter,zai,moonshot', ids(ordered).join(',') + ' — recentSignIns in src/models/catalogue/computedDefault.ts must read the latest record per family')
  const plan = usageSectionPlan(providerFamilyPresences())
  const pure = orderUsageSections(plan, ['zai'])
  const rest = plan.filter(s => s.family.credentialed && s.id !== 'zai').map(s => s.id)
  check('pure: a recency list naming one family puts it first and keeps plan order for the rest of the signed-in set (a stable sort)', ids(pure).slice(0, 4).join(',') === ['zai', ...rest].join(','), ids(pure).join(',') + ' — orderUsageSections in src/screen/settings/usage/plan.ts must sort stably, recency names first')
}

section('§3 nothing signed in: every section is absent and catalogue order stands')
{
  for (const name of CREDENTIAL_ENVS) delete process.env[name]
  discovery.__resetProviderDiscoveryForTest()
  const plan = usageSectionPlan(providerFamilyPresences())
  const recency = recentSignIns().map(c => c.family)
  check('the shared owner orders no credential (the records outlive the credentials, but order nothing)', recency.length === 0, recency.join(',') + ' — recentSignIns in src/models/catalogue/computedDefault.ts must list only families with a live credential')
  const ordered = orderUsageSections(plan, recency)
  check('every family absent ⇒ the listing is the catalogue order', ids(ordered).join(',') === ids(plan).join(','), ids(ordered).join(',') + ' — orderUsageSections in src/screen/settings/usage/plan.ts must return plan order for an empty recency list')
  check('…and no family leads by name (anthropic leads only because the catalogue lists it first)', plan.every(s => !s.family.credentialed))
}


console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-usage-listing-recency${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
