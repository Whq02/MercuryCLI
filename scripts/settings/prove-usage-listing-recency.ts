#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-usage-listing-recency.ts — the /usage surface
//  lists every signed-in provider ordered by the most recent sign-in (the
//  usage-neutrality law, row 3), sharing the ONE sign-in ledger the
//  computed default reads — never a second copy of the rule — with the
//  absent families after them in catalogue order and the first-party
//  buckets unchanged in shape.
//
//  Before this order the tab ranked the first-party family FIRST by name,
//  then the connected families in catalogue order: vendor favouritism on a
//  ten-family surface, and no notion of which provider the operator
//  actually signed into last.
//
//   §1 the order over a fixture ledger: timed sign-ins newest first, the
//      untimed credential after them, the absent families last in
//      catalogue order, the first-party family nowhere special
//   §2 a later sign-in re-orders the listing
//   §3 nothing signed in: catalogue order stands
//   §4 the shape: one ledger owner, no rank-by-name, both layouts follow
//   §5 the first-party buckets keep their shape
//
//  Run:  ~/.bun/bin/bun run scripts/settings/prove-usage-listing-recency.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
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
// Four signed-in families by env; three of them get a recorded sign-in
// time below, the fourth (Moonshot) stays untimed — the env pin's honest
// state in the ledger's own law.
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
const ROOT = join(import.meta.dir, '..', '..')

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const discovery = await import('../../src/utils/router/providerDiscovery.js')
const ledger = await import('../../src/utils/accounts/signInLedger.ts')
const { recentSignIns } = await import('../../src/utils/model/computedDefault.ts')
const { providerFamilyPresences } = await import('../../src/services/providers/providerUsage.ts')
const { usageSectionPlan, orderUsageSections } = await import('../../src/components/Settings/Usage.tsx')

const T = 1_760_000_000_000
const ids = (sections: ReadonlyArray<{ id: string }>): string[] => sections.map(s => s.id)

console.log('the /usage listing: every signed-in provider by its most recent sign-in, the shared ledger\'s order')

// ── §1 the order over a fixture ledger ──────────────────────────────────────
section('§1 timed sign-ins newest first, the untimed credential after, the absent families last in catalogue order')
{
  discovery.__resetProviderDiscoveryForTest()
  const plan = usageSectionPlan(providerFamilyPresences())
  const signedIn = plan.filter(s => s.family.credentialed).map(s => s.id).sort()
  check('the fixture home signs four families in (zai · deepseek · openrouter · moonshot)', signedIn.join(',') === 'deepseek,moonshot,openrouter,zai', signedIn.join(','))
  check('the plan itself keeps catalogue order (the derivation-law provers stand)', ids(plan)[0] === 'anthropic')
  check('deepseek signs in first', ledger.recordSignIn('deepseek', 'api-key', { now: () => T + 1_000 }))
  check('zai signs in second', ledger.recordSignIn('zai', 'api-key', { now: () => T + 2_000 }))
  check('openrouter signs in last', ledger.recordSignIn('openrouter', 'oauth', { now: () => T + 3_000 }))
  // A recorded sign-in for a family with NO credential today must not
  // order anything — the ledger orders credentials the home still holds.
  check('a departed family (gemini) has a record but no credential', ledger.recordSignIn('gemini', 'oauth', { now: () => T + 9_000 }))
  const recency = recentSignIns().map(c => c.family)
  check('the shared owner orders the credentials: openrouter, zai, deepseek, then the untimed moonshot; gemini absent', recency.join(',') === 'openrouter,zai,deepseek,moonshot', recency.join(','))
  const ordered = orderUsageSections(plan, recency)
  const absentTail = plan.filter(s => !s.family.credentialed).map(s => s.id)
  check('the listing leads with the most recent sign-in and follows the ledger', ids(ordered).slice(0, 4).join(',') === 'openrouter,zai,deepseek,moonshot', ids(ordered).join(','))
  check('the absent families follow in catalogue order', ids(ordered).slice(4).join(',') === absentTail.join(','), ids(ordered).join(','))
  check('the first-party family leads nothing by name — absent here, it sits in the absent tail at its catalogue position', ids(ordered)[0] !== 'anthropic' && ids(ordered).indexOf('anthropic') === 4 + absentTail.indexOf('anthropic'))
  check('every family is listed exactly once', ids(ordered).length === plan.length && new Set(ids(ordered)).size === plan.length)
}

// ── §2 a later sign-in re-orders ────────────────────────────────────────────
section('§2 a later sign-in re-orders the listing')
{
  check('deepseek signs in again, later than every other', ledger.recordSignIn('deepseek', 'api-key', { now: () => T + 5_000 }))
  const ordered = orderUsageSections(usageSectionPlan(providerFamilyPresences()), recentSignIns().map(c => c.family))
  check('deepseek now leads; openrouter and zai keep their relative order; moonshot stays untimed after them', ids(ordered).slice(0, 4).join(',') === 'deepseek,openrouter,zai,moonshot', ids(ordered).join(','))
  const plan = usageSectionPlan(providerFamilyPresences())
  const pure = orderUsageSections(plan, ['zai'])
  const rest = plan.filter(s => s.family.credentialed && s.id !== 'zai').map(s => s.id)
  check('pure: a recency list naming one family puts it first and keeps plan order for the rest of the signed-in set (a stable sort)', ids(pure).slice(0, 4).join(',') === ['zai', ...rest].join(','), ids(pure).join(','))
}

// ── §3 nothing signed in ────────────────────────────────────────────────────
section('§3 nothing signed in: every section is absent and catalogue order stands')
{
  for (const name of CREDENTIAL_ENVS) delete process.env[name]
  discovery.__resetProviderDiscoveryForTest()
  const plan = usageSectionPlan(providerFamilyPresences())
  const recency = recentSignIns().map(c => c.family)
  check('the shared owner orders no credential (the records outlive the credentials, but order nothing)', recency.length === 0, recency.join(','))
  const ordered = orderUsageSections(plan, recency)
  check('every family absent ⇒ the listing is the catalogue order', ids(ordered).join(',') === ids(plan).join(','), ids(ordered).join(','))
  check('…and no family leads by name (anthropic leads only because the catalogue lists it first)', plan.every(s => !s.family.credentialed))
}

// ── §4 the shape ────────────────────────────────────────────────────────────
section('§4 the shape: one ledger owner, no rank-by-name, both layouts follow the order')
{
  const tab = readFileSync(join(ROOT, 'src/components/Settings/Usage.tsx'), 'utf8')
  check('the tab reads the recency through the computed default\'s owner (recentSignIns), never a ledger copy', tab.includes("import { recentSignIns } from '../../utils/model/computedDefault.js'") && !tab.includes('readSignInLedger') && !tab.includes('sign-ins.json'))
  check('the first-party-first rank is gone', !tab.includes("section.kind === 'anthropic' ? 0") && !/rank\(a\) - rank\(b\)/.test(tab))
  check('the listing order is applied once, over the catalogue-ordered plan', tab.includes('orderUsageSections(usageSectionPlan(providerFamilyPresences()), liveSignInRecency())'))
  check('the stacked layout walks the ordered plan', tab.includes('{plan.map(section =>'))
  check('the wide layout bands the ordered plan (the most recent sign-in is the first column)', tab.includes('bands.push(plan.slice(start, start + perRow))'))
  const ledgerSrc = readFileSync(join(ROOT, 'src/utils/accounts/signInLedger.ts'), 'utf8')
  check('the ledger stays the one owner of sign-in times (its file name is spelled there alone)', ledgerSrc.includes("SIGN_IN_LEDGER_FILE = '.sign-ins.json'"))
}

// ── §5 the first-party buckets keep their shape ─────────────────────────────
section('§5 the first-party buckets keep their shape')
{
  const tab = readFileSync(join(ROOT, 'src/components/Settings/Usage.tsx'), 'utf8')
  check('the five-hour meter is titled Current session', tab.includes('title="Current session"'))
  check('the weekly all-models meter keeps its title', tab.includes('title="Current week (all models)"'))
  check('the per-model weekly rows read the owner\'s pool view, every stated pool titled by its label (fable included)', tab.includes('anthropicPoolWindowViews()') && tab.includes('`Current week (${w.label})`') && !tab.includes('data.seven_day_'))
  check('the meters still derive from the owner view', tab.includes('anthropicWindowViews()'))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-usage-listing-recency${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
