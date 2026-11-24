#!/usr/bin/env bun
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
  'MERCURY_DEMO',
  'MERCURY_DEFAULT_FABLE_MODEL',
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

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()

const status = await import('../../src/commands/verbs/status.js')
const config = await import('../../src/screen/settings/Config.js')
const model = await import('../../src/models/catalogue/engineModel.js')

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

{
  const { resolveProviderUsability } = await import('../../src/models/roads/providerUsability.js')
  const localBlocker =
    resolveProviderUsability({
      anthropicApiKey: () => null,
      anthropicSubscriber: () => false,
      anthropicLimitStatus: () => 'allowed',
      gptSeat: () => ({ state: 'disabled', reason: 'x', why: 'no-account' }),
      zaiKeyPresent: () => false,
    } as never).local.blockers[0] ?? ''
  check(
    "the resolver's own local sentence sets up or starts a server, never /logins",
    localBlocker.includes('/localsetup') && localBlocker.includes('MERCURY_LOCAL_BASE_URL') && !localBlocker.includes('/logins'),
    `${localBlocker}; the local blocker sentence in resolveProviderUsability (src/models/roads/providerUsability.ts) must name /localsetup and MERCURY_LOCAL_BASE_URL and not /logins`,
  )
}

{
  type ConfigFamilies = Parameters<typeof config.configProviderRows>[0]
  const rows = config.configProviderRows([
    presence('openrouter', true, 'OpenRouter (OAuth-minted key)'),
    presence('gemini', false),
  ] as unknown as ConfigFamilies)
  check('config account rows carry the new families with their routes', rows.length === 2 && rows[0]!.label === 'OpenRouter account' && rows[0]!.valueText.includes('/accounts') && rows[1]!.valueText === 'not signed in — /logins connects', `${JSON.stringify(rows)}; configProviderRows in src/screen/settings/config/configRowFacts.ts must give each family an account row with its label and route`)

  const applies = config.configRowApplicability('anthropic', 'anthropic')
  check('an anthropic-scoped row applies on the anthropic lane', applies.applies === true, `${JSON.stringify(applies)}; configRowApplicability in src/screen/settings/config/configRowFacts.ts must apply an anthropic row on the anthropic lane`)
  for (const route of ['openai', 'zai', 'openrouter', 'gemini']) {
    const refused = config.configRowApplicability('anthropic', route)
    check(
      `refused on ${route} — copy names BOTH lanes`,
      refused.applies === false &&
        refused.naText.includes('Anthropic') &&
        refused.naText.includes('n/a') &&
        refused.refuseNote.includes('/model'),
      `${JSON.stringify(refused)}; configRowApplicability in src/screen/settings/config/configRowFacts.ts must refuse an anthropic row on this route with n/a copy naming both lanes and a /model note`,
    )
  }

  const thinking = config.thinkingRowApplicability as (model: string, reads?: { locked?: (id: string) => boolean; routeOf?: (id: string) => string | null }) => { applies: boolean; naText?: string; refuseNote?: string }
  check('RED ON THE BASE: the Thinking row applies on the Anthropic road where the model takes the control', thinking('claude-haiku-4-5-20251001').applies === true && thinking('claude-opus-4-7').applies === true, 'thinkingRowApplicability in src/screen/settings/config/configRowFacts.ts must apply on Anthropic models that take the thinking control')
  const alwaysOn = thinking('claude-fable-5-1')
  check('an Anthropic model whose thinking is always on says so in the row instead of an off that is not true', alwaysOn.applies === false && alwaysOn.naText === 'n/a — Fable 5.1 keeps thinking on' && alwaysOn.refuseNote!.includes('thinks on every request'), `${JSON.stringify(alwaysOn)}; thinkingRowApplicability in src/screen/settings/config/configRowFacts.ts must say the model keeps thinking on`)
  check('RED ON THE BASE: it applies on a GLM id whose thinking the dial moves', thinking('glm-5.2').applies === true, 'thinkingRowApplicability in src/screen/settings/config/configRowFacts.ts must apply on a GLM id whose thinking the dial moves')
  check('RED ON THE BASE: it applies on a DeepSeek id (the compat chat road)', thinking('deepseek-chat').applies === true, 'thinkingRowApplicability in src/screen/settings/config/configRowFacts.ts must apply on a DeepSeek id')
  check('RED ON THE BASE: it applies on a Kimi id', thinking('kimi-k2').applies === true, 'thinkingRowApplicability in src/screen/settings/config/configRowFacts.ts must apply on a Kimi id')
  check('it applies on a local id', thinking('qwen3.5:9b').applies === true, 'thinkingRowApplicability in src/screen/settings/config/configRowFacts.ts must apply on a local id')
  const locked = thinking('glm-5.3-flash')
  check('RED ON THE BASE: a thinking-locked GLM reads the lock, not a refusal', locked.applies === false && locked.naText === 'n/a — glm-5.3-flash keeps thinking on' && locked.refuseNote!.includes('locks thinking on'), `${JSON.stringify(locked)}; thinkingRowApplicability in src/screen/settings/config/configRowFacts.ts must read the lock for a thinking-locked GLM id`)
  const gpt = thinking('gpt-5.6-sol')
  check('RED ON THE BASE: a GPT id reads the effort-dial note', gpt.applies === false && gpt.naText === 'n/a — GPT models take the effort dial (gpt-5.6-sol is active)' && gpt.refuseNote!.includes('/effort'), `${JSON.stringify(gpt)}; thinkingRowApplicability in src/screen/settings/config/configRowFacts.ts must point a GPT id to the effort dial`)
  const injected = thinking('glm-5.3', { locked: () => true, routeOf: () => 'zai' })
  check('the reads stay injectable for a prover', injected.applies === false && injected.naText!.includes('glm-5.3'), `${JSON.stringify(injected)}; thinkingRowApplicability in src/screen/settings/config/configRowFacts.ts must use the injected locked and routeOf reads`)
}

{
  const count = (text: string): number => (text.match(/\(1M context\)/g) ?? []).length
  const literal = model.renderModelName('claude-fable-5[1m]')
  check('renderModelName owns the suffix note (exactly once, canonical id)', count(literal) === 1, `${literal}; renderModelName in src/models/catalogue/engineModel.ts must add the (1M context) note exactly once`)
  const suffixed = model.renderModelName(model.parseUserSpecifiedModel('fable[1m]'))
  check('the alias path carries the note exactly once too', count(suffixed) === 1, `${suffixed}; renderModelName and parseUserSpecifiedModel in src/models/catalogue/engineModel.ts must not add the (1M context) note twice for an alias`)
  const bare = model.renderModelName(model.parseUserSpecifiedModel('fable'))
  check('a bare setting carries no suffix note', count(bare) === 0, `${bare}; renderModelName in src/models/catalogue/engineModel.ts must not add the (1M context) note to a model without the [1m] suffix`)
  const description = model.getDefaultModelDescription()
  check('default description: at most one suffix note (hermetic decision)', count(description) <= 1, `${description}; getDefaultModelDescription in src/models/catalogue/engineModel.ts must not repeat the (1M context) note`)
  process.env.MERCURY_DEFAULT_FABLE_MODEL = 'claude-fable-5[1m]'
  const pinned = model.getDefaultModelDescription()
  check('default description: at most one suffix note (suffixed env pin)', count(pinned) <= 1, `${pinned}; getDefaultModelDescription in src/models/catalogue/engineModel.ts must not repeat the (1M context) note when the env pin carries [1m]`)
  delete process.env.MERCURY_DEFAULT_FABLE_MODEL
}

console.log('\n5. the headless text reading of a property (auth status on a terminal)')
{
  const React = (await import('react')).default
  const { Text } = await import('../../src/screen/themedRenderer.js')
  const el = React.createElement(Text, null, 'Login method', ' ', 'Max', ' Account')
  check('a <Text> element reads as its text', status.propertyValueToText(el) === 'Login method Max Account', `${status.propertyValueToText(el)}; propertyValueToText in src/commands/verbs/status.tsx must join the children of a Text element`)
  const nested = React.createElement(Text, null, 'email · ', React.createElement(Text, { dimColor: true }, 'op@example.com'), 42)
  check('nested elements and numbers read in order', status.propertyValueToText(nested) === 'email · op@example.com42', `${status.propertyValueToText(nested)}; propertyValueToText in src/commands/verbs/status.tsx must read nested elements and numbers in order`)
  check('a string[] value reads as a comma list', status.propertyValueToText(['user', 'project']) === 'user, project', 'propertyValueToText in src/commands/verbs/status.tsx must join a string array with commas')
  check('a bare string passes through', status.propertyValueToText('plain') === 'plain', 'propertyValueToText in src/commands/verbs/status.tsx must return a plain string unchanged')
  check('null / undefined / boolean read empty', status.propertyValueToText(null) === '' && status.propertyValueToText(undefined) === '' && status.propertyValueToText(true) === '', 'propertyValueToText in src/commands/verbs/status.tsx must return an empty string for null, undefined and boolean')
  check('the product walker agrees with this prover\'s textOf on a real element', status.propertyValueToText(nested) === textOf(nested))
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
