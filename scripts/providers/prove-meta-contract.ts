import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MODEL_API_KEY', 'META_API_KEY']) delete process.env[key]
process.env.MERCURY_META_API_BASE = 'http://127.0.0.1:1/v1'
const { enableConfigs } = await import('../../src/platform/settings/config.ts'); enableConfigs()
const { usageForProvider } = await import('../../src/models/roads/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/models/roads/providerUsability.ts')
const { refreshProviderDiscovery } = await import('../../src/models/roads/providerDiscovery.ts')
const { parseFamilyFocus } = await import('../../src/commands/logins/login.tsx')
const { parseDefaultProviderWord } = await import('../../src/commands/defaultprovider/defaultprovider.tsx')
const { loginFamilyRows, keyPageLine } = await import('../../src/models/sign-in/flow-cards/loginFamilyRows.ts')
const { keyLegTitle, keyLegStoreLine, keyLegGuardOpts, keyPromptPaneLines, loginsFlowStatusOf } = await import('../../src/screen/boot-face/BootLoginsScreen.tsx')
const { keyLaneProviderRows, keyConnectValue } = await import('../../src/models/catalogue/modelOptions.ts')
const { subModelConnectHome } = await import('../../src/models/catalogue/subModelSlots.ts')
const { buildProviderSnapshot } = await import('../../src/models/roads/modelRegistry.ts')
let count = 0
const metaFailureHint = 'change the Meta rows and words in src/models/roads/ (modelRegistry.ts, providerUsage.ts, providerUsability.ts, providerDiscovery.ts), src/models/sign-in/flow-cards/loginFamilyRows.ts, src/screen/boot-face/BootLoginsScreen.tsx, src/models/catalogue/modelOptions.ts or src/models/catalogue/subModelSlots.ts, whichever this check names'
const check = (name: string, value: unknown): void => { assert.ok(value, `${name} — ${metaFailureHint}`); count++; console.log(`[PASS] ${name}`) }
try {
  check('Meta is a primary provider, with a signed-out usage and readiness truth', buildProviderSnapshot().providers.some(provider => provider.id === 'meta') && usageForProvider('meta').sourceKind === 'none' && !resolveProviderUsability().meta.usable)
  check('both family words focus the same sign-in and default-provider doors', ['meta', 'muse'].every(word => parseFamilyFocus(word) === 'meta' && parseDefaultProviderWord(word) === 'meta'))
  const row = loginFamilyRows({ engineLegs: true }).find(row => row.value === 'meta')
  check('both sign-in surfaces name Meta, Muse Code sign-in and the API-key road identically', row?.label === 'Meta — Muse Code sign-in or API key' && loginsFlowStatusOf({ kind: 'pick', pick: 'meta', pickSel: 0 }) === row.label && keyPageLine('meta').includes('dev.meta.ai'))
  const connect = keyLaneProviderRows({ zaiKeyPresent: () => false, moonshotCredentialPresent: () => false, deepseekKeyPresent: () => false, metaKeyPresent: () => false, compat: () => undefined }).find(option => option.value === keyConnectValue('meta'))
  check('both model pickers name the same two Meta sign-in roads', connect?.description === 'opens /logins meta (Muse Code sign-in or API key) — MODEL_API_KEY works too' && subModelConnectHome('meta').command === '/logins meta' && subModelConnectHome('meta').note === 'connect — /logins meta (Muse Code sign-in or API key)')
  check('the face says pay-as-you-go and env precedence on the key leg while directing Muse Code plans to Sign in with Meta', keyLegTitle('meta') === 'Meta Model API key' && keyLegStoreLine('meta').includes('MODEL_API_KEY, then META_API_KEY') && keyLegStoreLine('meta').includes('Sign in with Meta connects a Muse Code plan') && keyPromptPaneLines('meta', null, 8, false).join(' ').includes('dev.meta.ai'))
  process.env.MODEL_API_KEY = 'meta-fixture-presence-only'
  const usage = usageForProvider('meta')
  check('keyed usage is API spend with explicit allowance absence', usage.sourceKind === 'api-key' && usage.shape === 'api-spend' && usage.windows.length === 0 && usage.absence?.includes('pay-as-you-go'))
  check('the key makes Meta usable, not another provider', resolveProviderUsability().meta.usable)
  const discovery = await refreshProviderDiscovery('meta', { force: true })
  check('discovery records Meta rather than falling through to another family', discovery?.provider === 'meta' && discovery.keyPresent && discovery.keySource === 'env')
  console.log(`META CONTRACT GREEN (${count} checks; no provider request)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
