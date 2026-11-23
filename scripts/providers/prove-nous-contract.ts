import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NOUS_API_KEY
process.env.MERCURY_NOUS_API_BASE = 'http://127.0.0.1:1/v1'
process.env.MERCURY_NOUS_PORTAL_BASE = 'http://127.0.0.1:1'
const { enableConfigs } = await import('../../src/platform/settings/config.ts'); enableConfigs()
const { usageForProvider } = await import('../../src/models/roads/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/models/roads/providerUsability.ts')
const { refreshProviderDiscovery } = await import('../../src/models/roads/providerDiscovery.ts')
const { parseFamilyFocus } = await import('../../src/commands/logins/login.tsx')
const { parseDefaultProviderWord } = await import('../../src/commands/defaultprovider/defaultprovider.tsx')
const { loginFamilyRows, keyPageLine } = await import('../../src/models/sign-in/flow-cards/loginFamilyRows.ts')
const { keyLegTitle, keyLegStoreLine, keyLegGuardOpts, keyPromptPaneLines } = await import('../../src/screen/boot-face/BootLoginsScreen.tsx')
const { buildProviderSnapshot } = await import('../../src/models/roads/modelRegistry.ts')
const { declaredRouteOf, providerDisplayName, canonicalWireModelId } = await import('../../src/models/roads/routeLaw.ts')
const { PROVIDER_CREDENTIAL_ENV_VARS, PROVIDER_CREDENTIAL_VALUE_SHAPES } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
const { getModelOptions } = await import('../../src/models/catalogue/modelOptions.ts')
const { NOUS_MODEL_GROUP, NOUS_CONNECT_OPTION_VALUE, getNousAvailability } = await import('../../src/models/roads/nous/nousCatalogue.ts')
const { NOUS_CONNECT_ROWS, NOUS_KEY_LEG_OFFER } = await import('../../src/models/roads/nous/nousLogin.ts')
const { NOUS_SIGNIN_EXPIRED_LINE } = await import('../../src/models/roads/nous/nousOauth.ts')
const { NOUS_PORTAL_CLIENT_ID } = await import('../../src/models/roads/nous/nousClientContract.ts')
const { loginsPickOptions, loginsPickPaneLines, deviceFamilyWords } = await import('../../src/screen/boot-face/BootLoginsScreen.tsx')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  check('Nous Portal is a primary provider with a signed-out usage and readiness truth', buildProviderSnapshot().providers.some(provider => provider.id === 'nous') && usageForProvider('nous').sourceKind === 'none' && !resolveProviderUsability().nous.usable)
  check('the family words focus the same sign-in and default-provider doors', ['nous', 'nous-portal'].every(word => parseFamilyFocus(word) === 'nous' && parseDefaultProviderWord(word) === 'nous'))
  check('nous/<vendor>/<model> is a declared carrier namespace with the Portal slug on the wire', declaredRouteOf('nous/anthropic/claude-sonnet-4.6') === 'nous' && providerDisplayName('nous') === 'Nous Portal' && canonicalWireModelId('nous/openai/gpt-5.5-pro').ok && (canonicalWireModelId('nous/openai/gpt-5.5-pro') as { wireId?: string }).wireId === 'openai/gpt-5.5-pro')
  check('the only credential spelling is the API key, redacted by its prefix', JSON.stringify(PROVIDER_CREDENTIAL_ENV_VARS.nous) === JSON.stringify(['NOUS_API_KEY']) && PROVIDER_CREDENTIAL_VALUE_SHAPES.nous?.marker === '[REDACTED_NOUS_KEY]')
  const row = loginFamilyRows({ engineLegs: true }).find(row => row.value === 'nous')
  check('the sign-in row names the Portal, the account sign-in and the API-key road', row?.label === 'Nous Portal — sign-in or API key' && keyPageLine('nous').includes('portal.nousresearch.com'))
  check('the face says the key bills the Portal account and names the env precedence', keyLegTitle('nous') === 'Nous Portal API key' && keyLegStoreLine('nous').includes('NOUS_API_KEY wins over the store') && keyPromptPaneLines('nous', null, 8, false).join(' ').includes('portal.nousresearch.com'))
  const signedOut = getModelOptions().filter(option => option.group === NOUS_MODEL_GROUP)
  check('signed out, the group is one action row that runs /logins nous and no invented model', signedOut.length === 1 && signedOut[0]?.value === NOUS_CONNECT_OPTION_VALUE && signedOut[0].description.includes('/logins nous') && getNousAvailability().state === 'disabled')
  process.env.NOUS_API_KEY = 'sk-nous-fixture-presence-only-0123456789'
  const usage = usageForProvider('nous')
  check('keyed usage is API spend whose credits wait on the Portal account endpoint, never a fabricated figure', usage.sourceKind === 'api-key' && usage.shape === 'api-spend' && usage.windows.length === 0 && usage.credits.state === 'unreported' && usage.credits.reason.includes('Portal account endpoint'))
  check('the key makes Nous Portal usable, not another provider', resolveProviderUsability().nous.usable)
  const discovery = await refreshProviderDiscovery('nous', { force: true })
  check('discovery records Nous Portal rather than falling through to another family', discovery?.provider === 'nous' && discovery.keyPresent && discovery.keySource === 'env')
  const engines = readFileSync(join(import.meta.dir, '..', '..', 'docs/ENGINES.md'), 'utf8')
  check('the engines document names the Portal client id', engines.includes(`\`${NOUS_PORTAL_CLIENT_ID}\``))
  console.log(`NOUS CONTRACT GREEN (${count} checks; no provider request)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
