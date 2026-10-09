import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.OPENCODE_API_KEY
process.env.MERCURY_ZEN_API_BASE = 'http://127.0.0.1:1/zen/v1'
process.env.MERCURY_ZEN_GO_API_BASE = 'http://127.0.0.1:1/zen/go/v1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { usageForProvider } = await import('../../src/services/providers/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { refreshProviderDiscovery } = await import('../../src/utils/router/providerDiscovery.ts')
const { parseFamilyFocus } = await import('../../src/commands/login/login.tsx')
const { parseDefaultProviderWord } = await import('../../src/commands/defaultprovider/defaultprovider.tsx')
const { loginFamilyRows, keyPageLine, KEY_PAGES } = await import('../../src/components/loginFamilyRows.ts')
const { keyLegTitle, keyLegStoreLine, keyLegGuardOpts, keyPromptPaneLines } = await import('../../src/components/BootLoginsScreen.tsx')
const { buildRouterModelSnapshot } = await import('../../src/utils/router/modelRegistry.ts')
const { getModelOptions, ZEN_MODEL_GROUP, parseKeyConnectValue, keyConnectValue } = await import('../../src/utils/model/modelOptions.ts')
const { providerDisplayName, declaredRouteOf, canonicalWireModelId } = await import('../../src/services/providers/routeLaw.ts')
const { PROVIDER_ID_SPACES, declaredIdSpacesLine } = await import('../../src/services/providers/idSpaces.ts')
const { ZEN_DISPLAY_PINS, zenDisplayPin, zenIsFreeModel } = await import('../../src/services/providers/zen/zenPins.ts')
const { resolveModelPricing } = await import('../../src/utils/modelCost.ts')
const { effortVocabularyFor, resolveContextWindow, getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.ts')
const { readModelListFacts } = await import('../../src/services/providers/typedModelIds.ts')
const { PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
const root = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  check('zen is a declared qualified id space at the END of the one table, named OpenCode Zen', PROVIDER_ID_SPACES.at(-1)?.route === 'zen' && PROVIDER_ID_SPACES.at(-1)?.qualifiedPrefix === 'zen/' && providerDisplayName('zen') === 'OpenCode Zen' && declaredIdSpacesLine().includes('zen/…'))
  check('zen/<id> routes to zen and strips for the wire; a dressed id heals; an empty inner name refuses', declaredRouteOf('zen/kimi-k3') === 'zen' && (canonicalWireModelId('zen/kimi-k3[1m]') as { wireId: string; healed?: true }).healed === true && canonicalWireModelId('zen/').ok === false)
  check('Zen is a primary provider, with a signed-out usage and readiness truth', buildRouterModelSnapshot().providers.some(provider => provider.id === 'zen') && usageForProvider('zen').sourceKind === 'none' && !resolveProviderUsability().zen.usable)
  check('both family words focus the same sign-in and default-provider doors', ['zen', 'opencode'].every(word => parseFamilyFocus(word) === 'zen' && parseDefaultProviderWord(word) === 'zen'))
  const row = loginFamilyRows({ engineLegs: true }).find(row => row.value === 'zen')
  check('the sign-in row is the last engine row and names the API-key road and the console', loginFamilyRows({ engineLegs: true }).at(-1)?.value === 'zen' && row?.label === "OpenCode Zen — API key (one key, the gateway's model list)" && KEY_PAGES.zen === 'opencode.ai/auth' && keyPageLine('zen').includes('opencode.ai/auth'))
  check('both login skins use the owning key driver and the same guard', read('src/components/ZenConnect.tsx').includes('storeZenApiKeyLogin') && read('src/components/BootLoginsScreen.tsx').includes('storeZenApiKeyLogin(value)') && keyLegGuardOpts('zen').stores === 'an OpenCode Zen API key (sk-…)')
  check('the face names the usage-endpoint check and the env precedence', keyLegTitle('zen') === 'OpenCode Zen API key' && keyLegStoreLine('zen').includes('usage endpoint first') && keyLegStoreLine('zen').includes('OPENCODE_API_KEY wins') && keyPromptPaneLines('zen', null, 8, false).join(' ').includes('opencode.ai/auth'))
  check('the picker carries the Zen group with a connect row while signed out', getModelOptions().some(option => option.group === ZEN_MODEL_GROUP && option.value === keyConnectValue('zen')) && parseKeyConnectValue(keyConnectValue('zen')) === 'zen')
  check('the one env spelling is the vendor\'s', PROVIDER_CREDENTIAL_ENV_VARS.zen.join() === 'OPENCODE_API_KEY')
  check('the 60 pins split into the two shapes this road carries, prices at the vendor\'s table', ZEN_DISPLAY_PINS.filter(pin => pin.shape === 'responses').length === 32 && ZEN_DISPLAY_PINS.filter(pin => pin.shape === 'chat').length === 28 && zenDisplayPin('glm-5.3')?.costInPerMtok === 1.4 && zenDisplayPin('gpt-6-astra')?.longContext?.costInPerMtok === 20 && zenDisplayPin('mistral-large-4')?.costOutPerMtok === 2.09)
  const pricing = resolveModelPricing('zen/gpt-6-astra', { promptTokens: 300_000 })
  check('pricing rides the zen owner with the long-context tier past 272K; free rows price at zero', pricing.costs?.inputTokens === 20 && pricing.costs?.outputTokens === 75 && resolveModelPricing('zen/gpt-6-astra', { promptTokens: 1000 }).costs?.inputTokens === 10 && resolveModelPricing('zen/big-pickle').costs?.inputTokens === 0 && zenIsFreeModel('zen/big-pickle') && zenIsFreeModel('zen/space-bunny-free'))
  const effort = effortVocabularyFor('zen/gpt-5.5')
  check('the effort dial reads the pinned vocabulary and the thinking-off word', effort.kind === 'provider' && effort.vocabulary.join() === 'none,low,medium,high,xhigh' && effort.thinkingGated && effort.thinkingOffWire === 'none')
  check('a pin without an effort vocabulary offers no dial, honestly', effortVocabularyFor('zen/minimax-m3').kind === 'none')
  check('the context window and output ceiling come from the pins', resolveContextWindow('zen/kimi-k3').effectiveWindow === 1_048_576 && getModelMaxOutputTokens('zen/deepseek-v4-pro').upperLimit === 384_000)
  process.env.OPENCODE_API_KEY = 'sk-zen-fixture-presence-only-00000000000000000000000000000000000000000000'
  const usage = usageForProvider('zen')
  check('keyed usage is API spend with the console-only balance line, no invented figure', usage.sourceKind === 'api-key' && usage.shape === 'api-spend' && usage.credits.state === 'unreported' && (usage.absence ?? '').includes('console'))
  check('the key makes Zen usable, not another provider', resolveProviderUsability().zen.usable && !resolveProviderUsability().meta.usable)
  const discovery = await refreshProviderDiscovery('zen', { force: true })
  check('discovery records Zen rather than falling through to another family', discovery?.provider === 'zen' && discovery.keyPresent && discovery.keySource === 'env')
  check('the typed-id ledger carries a Zen fact beside the other families', readModelListFacts().some(fact => fact.family === 'zen' && fact.typed.length === 60))
  const files = ['Accounts', 'CallModel', 'Catalogue', 'Login', 'Pins', 'ResponsesTransport', 'UsageState'].map(part => `src/services/providers/zen/zen${part}.ts`)
  files.push('src/utils/router/providers/zen.ts')
  for (const file of files) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
    const names: string[] = []
    for (const statement of source.statements) {
      if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
      if (ts.isVariableStatement(statement)) names.push(...statement.declarationList.declarations.map(declaration => declaration.name.getText(source)))
      else if ((ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.push(statement.name.text)
    }
    check(`${file} exports a declared contract`, names.length > 0)
    console.log(`[EXPORTS] ${file}: ${names.join(', ')}`)
  }
  check('both Zen bases are registered and pinned by the hermetic gate', read('src/substrate/flagRegistry.ts').includes("env: 'MERCURY_ZEN_API_BASE'") && read('src/substrate/flagRegistry.ts').includes("env: 'MERCURY_ZEN_GO_API_BASE'") && read('scripts/gate/ci-shard.sh').includes('MERCURY_ZEN_API_BASE MERCURY_ZEN_GO_API_BASE'))
  check('no product surface carries bespoke words for what the road does not serve', !/this build/.test(read('src/services/providers/zen/zenCallModel.ts') + read('src/services/providers/zen/zenCatalogue.ts') + read('src/utils/model/modelOptions.ts')))
  console.log(`ZEN CONTRACT GREEN (${count} checks; no provider request)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
