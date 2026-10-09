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
const { NOUS_CONNECT_ROWS, NOUS_KEY_LEG_OFFER } = await import('../../src/services/providers/nous/nousLogin.ts')
const { NOUS_SIGNIN_EXPIRED_LINE } = await import('../../src/services/providers/nous/nousOauth.ts')
const { NOUS_PORTAL_CLIENT_ID } = await import('../../src/services/providers/nous/nousClientContract.ts')
const { loginsPickOptions, loginsPickPaneLines, deviceFamilyWords } = await import('../../src/components/BootLoginsScreen.tsx')
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
  check('the sign-in row names the Portal, the account sign-in and the API-key road', row?.label === 'Nous Portal — account sign-in or API key (model gateway)' && keyPageLine('nous').includes('portal.nousresearch.com'))
  check('both login skins use the owning key driver and the same guard', read('src/components/NousConnect.tsx').includes('storeNousApiKeyLogin') && read('src/components/BootLoginsScreen.tsx').includes('storeNousApiKeyLogin(value)') && keyLegGuardOpts('nous').stores === 'a Nous Portal API key')
  check('both login skins open the same two doors: the account sign-in first, the key leg second', NOUS_CONNECT_ROWS.map(r => r.value).join(',') === 'device,key' && JSON.stringify(loginsPickOptions('nous')) === JSON.stringify(NOUS_CONNECT_ROWS) && read('src/components/NousConnect.tsx').includes('runNousDeviceLogin') && read('src/components/BootLoginsScreen.tsx').includes("startDeviceRun('nous')"))
  check('the door is the Portal device-code road under one presented client id, with the rotating refresh in its own header and the durable mark beside the pair', read('src/services/providers/nous/nousOauth.ts').includes("'/api/oauth/device/code'") && read('src/services/providers/nous/nousOauth.ts').includes("NOUS_REFRESH_TOKEN_HEADER = 'x-nous-refresh-token'") && read('src/services/providers/nous/nousOauth.ts').includes('markNousSigninRefused') && read('src/services/providers/nous/nousOauth.ts').includes('presentedNousClient()') && !read('src/services/providers/nous/nousOauth.ts').includes(`'${NOUS_PORTAL_CLIENT_ID}'`))
  check('every failure road ends at the key leg with one plain line, and the expired mark reads the same line everywhere', NOUS_KEY_LEG_OFFER === '/logins nous retries the sign-in or stores an API key.' && NOUS_SIGNIN_EXPIRED_LINE === 'Nous Portal sign-in expired — sign in again (/logins nous) or use an API key' && read('src/services/providers/providerUsability.ts').includes(NOUS_SIGNIN_EXPIRED_LINE) && read('src/services/providers/nous/nousCatalogue.ts').includes('NOUS_SIGNIN_EXPIRED_LINE') && read('src/services/providers/primaryBackend.ts').includes('NOUS_SIGNIN_EXPIRED_LINE') && read('src/services/providers/accountSlots.ts').includes('NOUS_SIGNIN_EXPIRED_LINE'))
  const userFacing = [...NOUS_CONNECT_ROWS.map(r => r.label), NOUS_KEY_LEG_OFFER, NOUS_SIGNIN_EXPIRED_LINE, ...loginsPickPaneLines('nous'), deviceFamilyWords('nous'), ...read('src/components/NousConnect.tsx').match(/<Text[^>]*>([^<{]+)/g) ?? []]
  check('no user-facing word of the door names the other product', userFacing.every(words => !/hermes/i.test(words)) && !/hermes/i.test(read('src/components/NousConnect.tsx').replace(/import[^\n]*\n/g, '')) && !/hermes/i.test(read('src/services/providers/nous/nousLogin.ts')))
  check('the face says the key bills the Portal account and names the env precedence', keyLegTitle('nous') === 'Nous Portal API key' && keyLegStoreLine('nous').includes('NOUS_API_KEY wins over the store') && keyPromptPaneLines('nous', null, 8, false).join(' ').includes('portal.nousresearch.com'))
  const signedOut = getModelOptions().filter(option => option.group === NOUS_MODEL_GROUP)
  check('signed out, the group is one action row that runs /logins nous and no invented model', signedOut.length === 1 && signedOut[0]?.value === NOUS_CONNECT_OPTION_VALUE && signedOut[0].description.includes('/logins nous') && getNousAvailability().state === 'disabled')
  process.env.NOUS_API_KEY = 'sk-nous-fixture-presence-only-0123456789'
  const usage = usageForProvider('nous')
  check('keyed usage is API spend whose credits wait on the Portal account endpoint, never a fabricated figure', usage.sourceKind === 'api-key' && usage.shape === 'api-spend' && usage.windows.length === 0 && usage.credits.state === 'unreported' && usage.credits.reason.includes('Portal account endpoint'))
  check('the key makes Nous Portal usable, not another provider', resolveProviderUsability().nous.usable)
  const discovery = await refreshProviderDiscovery('nous', { force: true })
  check('discovery records Nous Portal rather than falling through to another family', discovery?.provider === 'nous' && discovery.keyPresent && discovery.keySource === 'env')
  const files = ['Accounts', 'CallModel', 'Catalogue', 'Login', 'UsageState', 'Oauth', 'ClientContract'].map(part => `src/services/providers/nous/nous${part}.ts`)
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
    check(`${file} spells the Portal client id only in the one contract constant`, file.endsWith('nousClientContract.ts') ? text.includes(`export const NOUS_PORTAL_CLIENT_ID = '${NOUS_PORTAL_CLIENT_ID}'`) : !text.includes(`'${NOUS_PORTAL_CLIENT_ID}'`))
    console.log(`[EXPORTS] ${file}: ${names.join(', ')}`)
  }
  check('the Portal bases and the client-source base are registered and pinned by the hermetic gate', read('src/substrate/flagRegistry.ts').includes("env: 'MERCURY_NOUS_API_BASE'") && read('src/substrate/flagRegistry.ts').includes("env: 'MERCURY_NOUS_PORTAL_BASE'") && read('src/substrate/flagRegistry.ts').includes("env: 'MERCURY_NOUS_CLIENT_SOURCE_BASE'") && read('scripts/gate/ci-shard.sh').includes('MERCURY_NOUS_API_BASE') && read('scripts/gate/ci-shard.sh').includes('MERCURY_NOUS_PORTAL_BASE') && read('scripts/gate/ci-shard.sh').includes('MERCURY_NOUS_CLIENT_SOURCE_BASE'))
  check('the engines document carries the family row and the meter, and stays key-only in words', read('docs/ENGINES.md').includes('| `nous` | `nous/<vendor>/<model>`') && read('docs/ENGINES.md').includes('/api/oauth/account') && !/nous portal[^\n]*device.code|nous portal[^\n]*sign in with/i.test(read('docs/ENGINES.md')))
  console.log(`NOUS CONTRACT GREEN (${count} checks; no provider request)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
