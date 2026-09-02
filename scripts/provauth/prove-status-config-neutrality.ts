#!/usr/bin/env bun
// ============================================================================
//  scripts/provauth/prove-status-config-neutrality.ts
//  PROOF: the Status accounts section is
//  provider-NEUTRAL and the Config tab is cross-provider honest.
//    1. buildProviderAccountBlocks derives ONE uniform block per registry
//       family — a fabricated family yields a block with no UI edit, and a
//       family list WITHOUT anthropic yields NO anthropic row (no baked-in
//       brand, no structural favourite);
//    2. absent families render the honest 'not logged in — /logins
//       connects'; connected families show the owning resolver's words;
//       identity continuation rows ride only provider-exposed facts and the
//       demo environment suppresses the personal ones; multi-credential
//       families name the wallet's arbitration;
//    3. configProviderRows carries the new families with their /accounts
//       routes; configRowApplicability refuses a provider-scoped row on
//       every other lane with copy that NAMES both lanes;
//    4. the model display line renders the 1M suffix EXACTLY once (the
//       'Fable 5 (1M context) (1M context)' Status-card bug class): the
//       display owner (renderModelName) carries the note and the subscriber
//       default description never appends a second;
//    5. the headless text reading of a property (propertyValueToText) reads
//       a <Text> tree as its text — `auth status --text` printed
//       "[object Object]" per row (TASK-014 w3-f03-04) — and auth.ts's text
//       path rides it.
//  Run:  ~/.bun/bin/bun run scripts/provauth/prove-status-config-neutrality.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' PROVAUTH — Status neutrality + Config cross-provider honesty')
console.log('============================================================')

const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'IS_DEMO',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ZAI_API_KEY',
]) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-status-neutral-'))

// Arm config reads BEFORE any real-owner path (the injected-doubles-mask
// lesson): the model-line leg walks getSettings/config through the frontier
// decision.
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const status = await import('../../src/utils/status.js')
const config = await import('../../src/components/Settings/Config.js')
const model = await import('../../src/utils/model/model.js')

// Extract the plain text of a Property value (a <Text> tree or string).
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    return textOf((node as { props: { children?: unknown } }).props.children)
  }
  return ''
}

type Presence = {
  id: string
  available: boolean
  credentialed: boolean
  credentialLabel?: string
}
const presence = (
  id: string,
  credentialed: boolean,
  credentialLabel?: string,
): Presence => ({
  id,
  available: credentialed,
  credentialed,
  ...(credentialLabel !== undefined ? { credentialLabel } : {}),
})

// ── 1+2. the neutral block grammar ──────────────────────────────────────────
{
  // The fabricated family widens the id union exactly like the established
  // neutral-surfaces double (a future catalogue this code has never seen).
  type Families = Parameters<typeof status.buildProviderAccountBlocks>[0]
  const families = [
    presence('anthropic', true, 'Claude subscription (max)'),
    presence('openai', false),
    presence('openrouter', true, 'OpenRouter (OAuth-minted key)'),
    presence('gemini', false),
    presence('fabricated-x', true, 'Fabricated credential'),
  ] as unknown as Families
  const entries = [
    {
      id: 'anthropic:oauth:primary',
      provider: 'anthropic' as const,
      kind: 'subscription-oauth' as const,
      label: 'Claude account (op@example.com)',
      identity: { email: 'op@example.com', plan: 'max' },
      custodian: 'anthropic-slots' as const,
    },
    {
      id: 'anthropic:api-key:env',
      provider: 'anthropic' as const,
      kind: 'api-key' as const,
      label: 'Anthropic API key (env)',
      custodian: 'anthropic-auth' as const,
    },
    {
      id: 'openrouter:oauth-key',
      provider: 'openrouter' as const,
      kind: 'api-key' as const,
      label: 'OpenRouter (OAuth-minted key)',
      custodian: 'openrouter-accounts' as const,
    },
  ]
  const reads = {
    entries: () => entries,
    activeFor: (provider: string) => entries.find(e => e.provider === provider),
    organization: () => 'Example Org',
    isDemo: false,
    // RE-TRUED for FC-076: absent families render their TYPED per-family
    // blocker from the usability resolver (injected here for hermeticity),
    // never one hardcoded sentence — the old pin asserted the defect (it
    // sent even sign-in-less families to /logins).
    usability: () => ({
      openai: { blockers: ['no OpenAI account is signed in — /logins openai'] },
      gemini: { blockers: ['no Gemini credential — /logins gemini (or GEMINI_API_KEY)'] },
    }),
  }
  const blocks = status.buildProviderAccountBlocks(families, reads)
  const labeled = blocks.filter(b => b.label !== '' && b.label !== undefined)
  check(
    'one primary row per family, registry order (fabricated family included — no edit needed)',
    labeled.length === 5 &&
      labeled.map(b => b.label).join(',') === 'anthropic,openai,openrouter,gemini,fabricated-x',
    labeled.map(b => String(b.label)).join(','),
  )
  const byLabel = new Map(labeled.map(b => [b.label, textOf(b.value)]))
  check(
    "absent family = its OWN typed blocker (FC-076), never one shared sentence",
    byLabel.get('openai') === 'no OpenAI account is signed in — /logins openai' &&
      byLabel.get('gemini') === 'no Gemini credential — /logins gemini (or GEMINI_API_KEY)' &&
      byLabel.get('openai') !== byLabel.get('gemini'),
    `openai=${JSON.stringify(byLabel.get('openai'))} gemini=${JSON.stringify(byLabel.get('gemini'))}`,
  )
  {
    // A family the injected map does not carry keeps the historical line
    // (fallback), and the LIVE resolver's own local sentence names a server
    // start — never a /logins door that has no Local option.
    const fallbackBlocks = status.buildProviderAccountBlocks(
      [presence('openai', false)] as unknown as Families,
      { ...reads, usability: () => ({}) },
    )
    check(
      'a family missing from the usability map falls back to the historical line',
      textOf(fallbackBlocks[0]?.value) === 'not logged in — /logins connects',
      String(textOf(fallbackBlocks[0]?.value)),
    )
    const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.js')
    const localBlocker =
      resolveProviderUsability({
        anthropicApiKey: () => null,
        anthropicSubscriber: () => false,
        anthropicLimitStatus: () => 'allowed',
        gptSeat: () => ({ state: 'disabled', reason: 'x', why: 'no-account' }),
        zaiKeyPresent: () => false,
      } as never).local.blockers[0] ?? ''
    check(
      "the resolver's own local sentence starts a server, never /logins",
      localBlocker.includes('start Ollama') && !localBlocker.includes('/logins'),
      localBlocker,
    )
  }
  check("connected family shows the owning resolver's words", byLabel.get('anthropic') === 'Claude subscription (max)' && byLabel.get('openrouter') === 'OpenRouter (OAuth-minted key)')
  check('an unknown family labels itself (never silent)', byLabel.get('fabricated-x') === 'Fabricated credential')
  const continuations = blocks.filter(b => b.label === '').map(b => textOf(b.value))
  check('identity continuations ride provider-exposed facts (email · plan · org)', continuations.some(t => t.includes('op@example.com')) && continuations.some(t => t.includes('plan · max')) && continuations.some(t => t.includes('org · Example Org')))
  check("multi-credential family names the wallet's arbitration", continuations.some(t => t.includes('sources · 2') && t.includes('active: Claude account (op@example.com)')))

  const demoBlocks = status.buildProviderAccountBlocks(families, { ...reads, isDemo: true })
  const demoText = demoBlocks.map(b => textOf(b.value)).join('\n')
  check('demo environment suppresses email + org (plan stays)', !demoText.includes('op@example.com') && !demoText.includes('Example Org') && demoText.includes('plan · max'))

  const withoutAnthropic = status.buildProviderAccountBlocks(families.slice(1), reads)
  check('NO baked-in brand: dropping anthropic from the registry drops its row', withoutAnthropic.every(b => b.label !== 'anthropic'))
}

// ── 3. config rows + applicability ──────────────────────────────────────────
{
  type ConfigFamilies = Parameters<typeof config.configProviderRows>[0]
  const rows = config.configProviderRows([
    presence('openrouter', true, 'OpenRouter (OAuth-minted key)'),
    presence('gemini', false),
  ] as unknown as ConfigFamilies)
  check('config account rows carry the new families with their routes', rows.length === 2 && rows[0]!.label === 'OpenRouter account' && rows[0]!.valueText.includes('/accounts') && rows[1]!.valueText === 'not signed in — /logins connects')

  const applies = config.configRowApplicability('anthropic', 'anthropic')
  check('an anthropic-scoped row applies on the anthropic lane', applies.applies === true)
  for (const route of ['openai', 'zai', 'openrouter', 'gemini']) {
    const refused = config.configRowApplicability('anthropic', route)
    check(
      `refused on ${route} — copy names BOTH lanes`,
      refused.applies === false &&
        refused.naText.includes('Anthropic') &&
        refused.naText.includes('n/a') &&
        refused.refuseNote.includes('/model'),
      JSON.stringify(refused),
    )
  }
}

// ── 4. the 1M suffix renders exactly once ───────────────────────────────────
{
  const count = (text: string): number => (text.match(/\(1M context\)/g) ?? []).length
  const literal = model.renderModelName('claude-fable-5[1m]')
  check('renderModelName owns the suffix note (exactly once, canonical id)', count(literal) === 1, literal)
  const suffixed = model.renderModelName(model.parseUserSpecifiedModel('fable[1m]'))
  check('the alias path carries the note exactly once too', count(suffixed) === 1, suffixed)
  const bare = model.renderModelName(model.parseUserSpecifiedModel('fable'))
  check('a bare setting carries no suffix note', count(bare) === 0, bare)
  // The subscriber default description must never append a second note —
  // under the env-pinned suffixed decision AND the hermetic default alike.
  const description = model.getDefaultModelDescription()
  check('default description: at most one suffix note (hermetic decision)', count(description) <= 1, description)
  process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'claude-fable-5[1m]'
  const pinned = model.getDefaultModelDescription()
  check('default description: at most one suffix note (suffixed env pin)', count(pinned) <= 1, pinned)
  delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
}

console.log('\n5. the headless text reading of a property (auth status --text)')
{
  // TASK-014 w3-f03-04: every row of `auth status --text` printed
  // "[object Object]" — String() over a <Text> element. The product now
  // owns the walker this prover always had to carry.
  const React = (await import('react')).default
  const { Text } = await import('../../src/ink.js')
  const el = React.createElement(Text, null, 'Login method', ' ', 'Max', ' Account')
  check('a <Text> element reads as its text', status.propertyValueToText(el) === 'Login method Max Account', status.propertyValueToText(el))
  const nested = React.createElement(Text, null, 'email · ', React.createElement(Text, { dimColor: true }, 'op@example.com'), 42)
  check('nested elements and numbers read in order', status.propertyValueToText(nested) === 'email · op@example.com42', status.propertyValueToText(nested))
  check('a string[] value reads as a comma list', status.propertyValueToText(['user', 'project']) === 'user, project')
  check('a bare string passes through', status.propertyValueToText('plain') === 'plain')
  check('null / undefined / boolean read empty', status.propertyValueToText(null) === '' && status.propertyValueToText(undefined) === '' && status.propertyValueToText(true) === '')
  check('the product walker agrees with this prover\'s textOf on a real element', status.propertyValueToText(nested) === textOf(nested))
  const authSrc = (await import('node:fs')).readFileSync(new URL('../../src/cli/handlers/auth.ts', import.meta.url), 'utf8')
  check('auth status --text renders rows through propertyValueToText', /const rendered = propertyValueToText\(value\)/.test(authSrc))
  check('no String(value) row rendering survives in the --text path', !/Array\.isArray\(value\) \? value\.join\(', '\) : String\(value\)/.test(authSrc))
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('============================================================')
if (failures > 0) {
  console.error(`❌ ${failures} status/config neutrality proof(s) failed`)
  process.exit(1)
}
console.log('✅ STATUS NEUTRALITY + CONFIG CROSS-PROVIDER HONESTY PROVEN')
