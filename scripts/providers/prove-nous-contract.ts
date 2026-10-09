import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NOUS_API_KEY
process.env.MERCURY_NOUS_API_BASE = 'http://127.0.0.1:1/v1'
process.env.MERCURY_NOUS_PORTAL_BASE = 'http://127.0.0.1:1'
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { usageForProvider } = await import('../../src/services/providers/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { refreshProviderDiscovery } = await import('../../src/utils/router/providerDiscovery.ts')
const { parseFamilyFocus } = await import('../../src/commands/login/login.tsx')
const { parseDefaultProviderWord } = await import('../../src/commands/defaultprovider/defaultprovider.tsx')
const { loginFamilyRows, keyPageLine } = await import('../../src/components/loginFamilyRows.ts')
const { keyLegTitle, keyLegStoreLine, keyLegGuardOpts, keyPromptPaneLines } = await import('../../src/components/BootLoginsScreen.tsx')
const { buildRouterModelSnapshot } = await import('../../src/utils/router/modelRegistry.ts')
const { declaredRouteOf, providerDisplayName, canonicalWireModelId } = await import('../../src/services/providers/routeLaw.ts')
const { PROVIDER_CREDENTIAL_ENV_VARS, PROVIDER_CREDENTIAL_VALUE_SHAPES } = await import('../../src/services/providers/credentialEnvSpellings.ts')
const { getModelOptions } = await import('../../src/utils/model/modelOptions.ts')
const { NOUS_MODEL_GROUP, NOUS_CONNECT_OPTION_VALUE, getNousAvailability } = await import('../../src/services/providers/nous/nousCatalogue.ts')
const root = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  check('Nous Portal is a primary provider with a signed-out usage and readiness truth', buildRouterModelSnapshot().providers.some(provider => provider.id === 'nous') && usageForProvider('nous').sourceKind === 'none' && !resolveProviderUsability().nous.usable)
  check('the family words focus the same sign-in and default-provider doors', ['nous', 'nous-portal'].every(word => parseFamilyFocus(word) === 'nous' && parseDefaultProviderWord(word) === 'nous'))
  check('nous/<vendor>/<model> is a declared carrier namespace with the Portal slug on the wire', declaredRouteOf('nous/anthropic/claude-sonnet-4.6') === 'nous' && providerDisplayName('nous') === 'Nous Portal' && canonicalWireModelId('nous/openai/gpt-5.5-pro').ok && (canonicalWireModelId('nous/openai/gpt-5.5-pro') as { wireId?: string }).wireId === 'openai/gpt-5.5-pro')
  check('the only credential spelling is the API key, redacted by its prefix', JSON.stringify(PROVIDER_CREDENTIAL_ENV_VARS.nous) === JSON.stringify(['NOUS_API_KEY']) && PROVIDER_CREDENTIAL_VALUE_SHAPES.nous?.marker === '[REDACTED_NOUS_KEY]')
  const row = loginFamilyRows({ engineLegs: true }).find(row => row.value === 'nous')
  check('the sign-in row names the Portal and the API-key road', row?.label.startsWith('Nous Portal — API key') && keyPageLine('nous').includes('portal.nousresearch.com'))
  check('both login skins use the owning key driver and the same guard', read('src/components/NousConnect.tsx').includes('storeNousApiKeyLogin') && read('src/components/BootLoginsScreen.tsx').includes('storeNousApiKeyLogin(value)') && keyLegGuardOpts('nous').stores === 'a Nous Portal API key')
  check('the face says the key bills the Portal account and names the env precedence', keyLegTitle('nous') === 'Nous Portal API key' && keyLegStoreLine('nous').includes('NOUS_API_KEY wins over the store') && keyPromptPaneLines('nous', null, 8, false).join(' ').includes('portal.nousresearch.com'))
  const signedOut = getModelOptions().filter(option => option.group === NOUS_MODEL_GROUP)
  check('signed out, the group is one action row that runs /logins nous and no invented model', signedOut.length === 1 && signedOut[0]?.value === NOUS_CONNECT_OPTION_VALUE && signedOut[0].description.includes('/logins nous') && getNousAvailability().state === 'disabled')
  process.env.NOUS_API_KEY = 'sk-nous-fixture-presence-only-0123456789'
  const usage = usageForProvider('nous')
  check('keyed usage is API spend whose credits wait on the Portal account endpoint, never a fabricated figure', usage.sourceKind === 'api-key' && usage.shape === 'api-spend' && usage.windows.length === 0 && usage.credits.state === 'unreported' && usage.credits.reason.includes('Portal account endpoint'))
  check('the key makes Nous Portal usable, not another provider', resolveProviderUsability().nous.usable)
  const discovery = await refreshProviderDiscovery('nous', { force: true })
  check('discovery records Nous Portal rather than falling through to another family', discovery?.provider === 'nous' && discovery.keyPresent && discovery.keySource === 'env')
  const files = ['Accounts', 'CallModel', 'Catalogue', 'Login', 'UsageState'].map(part => `src/services/providers/nous/nous${part}.ts`)
  files.push('src/utils/router/providers/nous.ts')
  for (const file of files) {
    const text = read(file)
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const names: string[] = []
    for (const statement of source.statements) {
      if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
      if (ts.isVariableStatement(statement)) names.push(...statement.declarationList.declarations.map(declaration => declaration.name.getText(source)))
      else if ((ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.push(statement.name.text)
    }
    check(`${file} exports a declared contract`, names.length > 0)
    check(`${file} carries no sign-in flow of another client`, !/oauth\/device|device_code|refresh_token|client_id|hermes-cli/i.test(text))
    console.log(`[EXPORTS] ${file}: ${names.join(', ')}`)
  }
  check('the Portal bases are registered and pinned by the hermetic gate', read('src/substrate/flagRegistry.ts').includes("env: 'MERCURY_NOUS_API_BASE'") && read('src/substrate/flagRegistry.ts').includes("env: 'MERCURY_NOUS_PORTAL_BASE'") && read('scripts/gate/ci-shard.sh').includes('MERCURY_NOUS_API_BASE') && read('scripts/gate/ci-shard.sh').includes('MERCURY_NOUS_PORTAL_BASE'))
  check('the engines document carries the family row and the meter', read('docs/ENGINES.md').includes('| `nous` | `nous/<vendor>/<model>`') && read('docs/ENGINES.md').includes('/api/oauth/account'))
  console.log(`NOUS CONTRACT GREEN (${count} checks; no provider request)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
