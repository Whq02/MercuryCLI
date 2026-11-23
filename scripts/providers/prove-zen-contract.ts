import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.OPENCODE_API_KEY
process.env.MERCURY_ZEN_API_BASE = 'http://127.0.0.1:1/zen/v1'
process.env.MERCURY_ZEN_GO_API_BASE = 'http://127.0.0.1:1/zen/go/v1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { enableConfigs } = await import('../../src/platform/settings/config.ts'); enableConfigs()
const { usageForProvider } = await import('../../src/models/roads/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/models/roads/providerUsability.ts')
const { refreshProviderDiscovery } = await import('../../src/models/roads/providerDiscovery.ts')
const { parseFamilyFocus } = await import('../../src/commands/logins/login.tsx')
const { parseDefaultProviderWord } = await import('../../src/commands/defaultprovider/defaultprovider.tsx')
const { loginFamilyRows, keyPageLine, KEY_PAGES } = await import('../../src/models/sign-in/flow-cards/loginFamilyRows.ts')
const { keyLegTitle, keyLegStoreLine, keyLegGuardOpts, keyPromptPaneLines } = await import('../../src/screen/boot-face/BootLoginsScreen.tsx')
const { buildProviderSnapshot } = await import('../../src/models/roads/modelRegistry.ts')
const { getModelOptions, ZEN_MODEL_GROUP, parseKeyConnectValue, keyConnectValue } = await import('../../src/models/catalogue/modelOptions.ts')
const { providerDisplayName, declaredRouteOf, canonicalWireModelId } = await import('../../src/models/roads/routeLaw.ts')
const { PROVIDER_ID_SPACES, declaredIdSpacesLine } = await import('../../src/models/roads/idSpaces.ts')
const { ZEN_DISPLAY_PINS, zenDisplayPin, zenIsFreeModel } = await import('../../src/models/facts/pins/zenPins.ts')
const { resolveModelPricing } = await import('../../src/models/usage/modelCost.ts')
const { effortVocabularyFor, resolveContextWindow, getModelMaxOutputTokens } = await import('../../src/models/facts/capabilities.ts')
const { readModelListFacts } = await import('../../src/models/roads/typedModelIds.ts')
const { PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')
let count = 0
const check = (name: string, value: unknown, where = ''): void => { assert.ok(value, where ? `${name} (change: ${where})` : name); count++; console.log(`[PASS] ${name}`) }
try {
  check('zen is a declared qualified id space at the END of the one table, named OpenCode Zen', PROVIDER_ID_SPACES.at(-1)?.route === 'zen' && PROVIDER_ID_SPACES.at(-1)?.qualifiedPrefix === 'zen/' && providerDisplayName('zen') === 'OpenCode Zen' && declaredIdSpacesLine().includes('zen/…'), 'PROVIDER_ID_SPACES and declaredIdSpacesLine in src/models/roads/idSpaces.ts, providerDisplayName in src/models/roads/routeLaw.ts')
  check('zen/<id> routes to zen and strips for the wire; a dressed id heals; an empty inner name refuses', declaredRouteOf('zen/kimi-k3') === 'zen' && (canonicalWireModelId('zen/kimi-k3[1m]') as { wireId: string; healed?: true }).healed === true && canonicalWireModelId('zen/').ok === false, 'declaredRouteOf and canonicalWireModelId in src/models/roads/routeLaw.ts')
  check('Zen is a primary provider, with a signed-out usage and readiness truth', buildProviderSnapshot().providers.some(provider => provider.id === 'zen') && usageForProvider('zen').sourceKind === 'none' && !resolveProviderUsability().zen.usable, 'buildProviderSnapshot in src/models/roads/modelRegistry.ts, usageForProvider in src/models/roads/providerUsage.ts, resolveProviderUsability in src/models/roads/providerUsability.ts')
  check('both family words focus the same sign-in and default-provider doors', ['zen', 'opencode'].every(word => parseFamilyFocus(word) === 'zen' && parseDefaultProviderWord(word) === 'zen'), 'parseFamilyFocus in src/commands/logins/login.tsx and parseDefaultProviderWord in src/commands/defaultprovider/defaultprovider.tsx must accept zen and opencode')
  const row = loginFamilyRows({ engineLegs: true }).find(row => row.value === 'zen')
  check('the sign-in row is the last engine row and names the API-key road and the console', loginFamilyRows({ engineLegs: true }).at(-1)?.value === 'zen' && row?.label === 'OpenCode Zen — API key' && KEY_PAGES.zen === 'opencode.ai/auth' && keyPageLine('zen').includes('opencode.ai/auth'), 'loginFamilyRows, KEY_PAGES and keyPageLine in src/models/sign-in/flow-cards/loginFamilyRows.ts')
  check('the face names the usage-endpoint check and the env precedence', keyLegTitle('zen') === 'OpenCode Zen API key' && keyLegStoreLine('zen').includes('usage endpoint first') && keyLegStoreLine('zen').includes('OPENCODE_API_KEY wins') && keyPromptPaneLines('zen', null, 8, false).join(' ').includes('opencode.ai/auth'), 'keyLegTitle, keyLegStoreLine and keyPromptPaneLines in src/screen/boot-face/BootLoginsScreen.tsx')
  check('the picker carries the Zen group with a connect row while signed out', getModelOptions().some(option => option.group === ZEN_MODEL_GROUP && option.value === keyConnectValue('zen')) && parseKeyConnectValue(keyConnectValue('zen')) === 'zen', 'getModelOptions, ZEN_MODEL_GROUP and keyConnectValue in src/models/catalogue/modelOptions.ts')
  check('the one env spelling is the vendor\'s', PROVIDER_CREDENTIAL_ENV_VARS.zen.join() === 'OPENCODE_API_KEY', 'PROVIDER_CREDENTIAL_ENV_VARS.zen in src/models/sign-in/credentials/credentialEnvSpellings.ts')
  check('the 68 pins (opencode.ai/docs/zen, read 2026-10-25, the two GPT 6.2 rows 2026-11-17) split into the two shapes this road carries, prices at the vendor\'s table', ZEN_DISPLAY_PINS.filter(pin => pin.shape === 'responses').length === 35 && ZEN_DISPLAY_PINS.filter(pin => pin.shape === 'chat').length === 33 && zenDisplayPin('glm-5.3')?.costInPerMtok === 1.4 && zenDisplayPin('gpt-6-astra')?.longContext?.costInPerMtok === 20 && zenDisplayPin('mistral-large-4')?.costOutPerMtok === 2.09, 'ZEN_DISPLAY_PINS and zenDisplayPin in src/models/facts/pins/zenPins.ts (35 responses pins, 33 chat pins, the vendor prices)')
  const pricing = resolveModelPricing('zen/gpt-6-astra', { promptTokens: 300_000 })
  check('pricing rides the zen owner with the long-context tier past 272K; free rows price at zero', pricing.costs?.inputTokens === 20 && pricing.costs?.outputTokens === 75 && resolveModelPricing('zen/gpt-6-astra', { promptTokens: 1000 }).costs?.inputTokens === 10 && resolveModelPricing('zen/big-pickle').costs?.inputTokens === 0 && zenIsFreeModel('zen/big-pickle') && zenIsFreeModel('zen/space-bunny-free'), 'resolveModelPricing in src/models/usage/modelCost.ts and zenIsFreeModel in src/models/facts/pins/zenPins.ts')
  const effort = effortVocabularyFor('zen/gpt-5.5')
  check('the effort dial reads the pinned vocabulary and the thinking-off word', effort.kind === 'provider' && effort.vocabulary.join() === 'none,low,medium,high,xhigh' && effort.thinkingGated && effort.thinkingOffWire === 'none', 'effortVocabularyFor in src/models/facts/capabilities.ts, reading the gpt-5.5 pin in src/models/facts/pins/zenPins.ts')
  check('a pin without an effort vocabulary offers no dial, honestly', effortVocabularyFor('zen/minimax-m3').kind === 'none', 'effortVocabularyFor in src/models/facts/capabilities.ts, the minimax-m3 pin in src/models/facts/pins/zenPins.ts')
  check('the context window and output ceiling come from the pins', resolveContextWindow('zen/kimi-k3').effectiveWindow === 1_048_576 && getModelMaxOutputTokens('zen/deepseek-v4-pro').upperLimit === 384_000, 'resolveContextWindow and getModelMaxOutputTokens in src/models/facts/capabilities.ts, the pins in src/models/facts/pins/zenPins.ts')
  process.env.OPENCODE_API_KEY = 'sk-zen-fixture-presence-only-00000000000000000000000000000000000000000000'
  const usage = usageForProvider('zen')
  check('keyed usage is API spend with the console-only balance line, no invented figure', usage.sourceKind === 'api-key' && usage.shape === 'api-spend' && usage.credits.state === 'unreported' && (usage.absence ?? '').includes('console'), 'usageForProvider for zen in src/models/roads/providerUsage.ts')
  check('the key makes Zen usable, not another provider', resolveProviderUsability().zen.usable && !resolveProviderUsability().meta.usable, 'resolveProviderUsability in src/models/roads/providerUsability.ts')
  const discovery = await refreshProviderDiscovery('zen', { force: true })
  check('discovery records Zen rather than falling through to another family', discovery?.provider === 'zen' && discovery.keyPresent && discovery.keySource === 'env', 'refreshProviderDiscovery in src/models/roads/providerDiscovery.ts')
  check('the typed-id ledger carries a Zen fact beside the other families', readModelListFacts().some(fact => fact.family === 'zen' && fact.typed.length === 68), 'readModelListFacts in src/models/roads/typedModelIds.ts must list the 68 zen pins')
  console.log(`ZEN CONTRACT GREEN (${count} checks; no provider request)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
