import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MODEL_API_KEY', 'META_API_KEY']) delete process.env[key]
process.env.MERCURY_META_API_BASE = 'http://127.0.0.1:1/v1'
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { usageForProvider } = await import('../../src/services/providers/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { refreshProviderDiscovery } = await import('../../src/utils/router/providerDiscovery.ts')
const { parseFamilyFocus } = await import('../../src/commands/login/login.tsx')
const { parseDefaultProviderWord } = await import('../../src/commands/defaultprovider/defaultprovider.tsx')
const { loginFamilyRows, keyPageLine } = await import('../../src/components/loginFamilyRows.ts')
const { keyLegTitle, keyLegStoreLine, keyLegGuardOpts, keyPromptPaneLines } = await import('../../src/components/BootLoginsScreen.tsx')
const { buildRouterModelSnapshot } = await import('../../src/utils/router/modelRegistry.ts')
const root = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  check('Meta is a primary provider, with a signed-out usage and readiness truth', buildRouterModelSnapshot().providers.some(provider => provider.id === 'meta') && usageForProvider('meta').sourceKind === 'none' && !resolveProviderUsability().meta.usable)
  const { buildFacts } = await import('../../src/commands/status/mercuryStatus.tsx')
  const status = buildFacts([], 'muse', {
    families: () => ['zai', 'moonshot', 'deepseek', 'meta'].map(id => ({ id, credentialed: false })) as never,
    accountUsage: () => ({ windows: [], shape: 'none' }) as never,
  })
  check('the grouped status row separates Meta from its account state', status.facts.find(row => row.k === 'keys')?.v === '  Z.AI · Moonshot · DeepSeek · Meta     not configured')
  check('both family words focus the same sign-in and default-provider doors', ['meta', 'muse'].every(word => parseFamilyFocus(word) === 'meta' && parseDefaultProviderWord(word) === 'meta'))
  const row = loginFamilyRows({ engineLegs: true }).find(row => row.value === 'meta')
  check('the sign-in row names Meta, Muse and the API-key road', row?.label === 'Meta — API key (Muse)' && keyPageLine('meta').includes('dev.meta.ai'))
  check('both login skins use the owning key driver and the same guard', read('src/components/MetaConnect.tsx').includes('storeMetaApiKeyLogin') && read('src/components/BootLoginsScreen.tsx').includes('storeMetaApiKeyLogin(value)') && keyLegGuardOpts('meta').stores === 'a Meta Model API key')
  check('the face says pay-as-you-go and env precedence without offering Muse Code OAuth', keyLegTitle('meta') === 'Meta Model API key' && keyLegStoreLine('meta').includes('MODEL_API_KEY, then META_API_KEY') && keyLegStoreLine('meta').includes('not a Muse Code plan') && keyPromptPaneLines('meta', null, 8, false).join(' ').includes('dev.meta.ai'))
  process.env.MODEL_API_KEY = 'meta-fixture-presence-only'
  const usage = usageForProvider('meta')
  check('keyed usage is API spend with explicit allowance absence', usage.sourceKind === 'api-key' && usage.shape === 'api-spend' && usage.windows.length === 0 && usage.absence?.includes('pay-as-you-go'))
  check('the key makes Meta usable, not another provider', resolveProviderUsability().meta.usable)
  const discovery = await refreshProviderDiscovery('meta', { force: true })
  check('discovery records Meta rather than falling through to another family', discovery?.provider === 'meta' && discovery.keyPresent && discovery.keySource === 'env')
  const files = ['Accounts', 'CallModel', 'Catalogue', 'Login', 'Pins', 'UsageState'].map(part => `src/services/providers/meta/meta${part}.ts`)
  files.push('src/utils/router/providers/meta.ts')
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
  check('the Meta base is registered and pinned by the hermetic gate', read('src/substrate/flagRegistry.ts').includes("env: 'MERCURY_META_API_BASE'") && read('scripts/gate/ci-shard.sh').includes('MERCURY_META_API_BASE'))
  console.log(`META CONTRACT GREEN (${count} checks; no provider request)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
