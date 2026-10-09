import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { mistralFixture, MISTRAL_FIXTURE_API_KEY, MISTRAL_FIXTURE_ADMIN_KEY } from './lib/mistral-fixture.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MISTRAL_API_KEY', 'MISTRAL_ADMIN_API_KEY']) delete process.env[key]
process.env.MERCURY_MISTRAL_API_BASE = 'http://127.0.0.1:1/v1'
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { usageForProvider, refreshProviderUsage } = await import('../../src/services/providers/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { refreshProviderDiscovery } = await import('../../src/utils/router/providerDiscovery.ts')
const { parseFamilyFocus } = await import('../../src/commands/login/login.tsx')
const { parseDefaultProviderWord } = await import('../../src/commands/defaultprovider/defaultprovider.tsx')
const { loginFamilyRows, keyPageLine } = await import('../../src/components/loginFamilyRows.ts')
const { keyLegTitle, keyLegStoreLine, keyLegGuardOpts, keyPromptPaneLines } = await import('../../src/components/BootLoginsScreen.tsx')
const { buildRouterModelSnapshot } = await import('../../src/utils/router/modelRegistry.ts')
const { MISTRAL_DISPLAY_PINS, mistralDisplayPin, isMistralChatModelId, isMistralModelId } = await import('../../src/services/providers/mistral/mistralPins.ts')
const { resolveModelPricing } = await import('../../src/utils/modelCost.ts')
const { effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
const { credentialEnvNames } = await import('../../src/utils/router/providerSecrets.ts')
const { deriveFamilySlotGroups } = await import('../../src/services/providers/accountSlots.ts')
const { __resetMistralUsageForTest, mistralObservedUsage } = await import('../../src/services/providers/mistral/mistralUsageState.ts')
const root = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
const fixture = mistralFixture()
try {
  check('Mistral is a primary provider, with a signed-out usage and readiness truth', buildRouterModelSnapshot().providers.some(provider => provider.id === 'mistral') && usageForProvider('mistral').sourceKind === 'none' && !resolveProviderUsability().mistral.usable)
  check('the family word focuses the sign-in and default-provider doors', parseFamilyFocus('mistral') === 'mistral' && parseDefaultProviderWord('mistral') === 'mistral')
  const row = loginFamilyRows({ engineLegs: true }).find(row => row.value === 'mistral')
  check('the sign-in row names the API-key road and the key page, never a browser sign-in', row?.label === 'Mistral — API key (Large 4, Medium 3.5, Small 4)' && keyPageLine('mistral').includes('console.mistral.ai/api-keys') && !read('src/components/loginFamilyRows.ts').toLowerCase().includes('vibe'))
  check('both login skins use the owning key driver and the same guard', read('src/components/MistralConnect.tsx').includes('storeMistralApiKeyLogin') && read('src/components/BootLoginsScreen.tsx').includes('storeMistralApiKeyLogin(value)') && keyLegGuardOpts('mistral').stores === 'a Mistral API key')
  check('the face names the model-list proof, env precedence and the optional Admin API key', keyLegTitle('mistral') === 'Mistral API key' && keyLegStoreLine('mistral').includes('MISTRAL_API_KEY wins') && keyLegTitle('mistral-admin') === 'Mistral Admin API key (optional)' && keyPromptPaneLines('mistral', null, 8, false).join(' ').includes('console.mistral.ai/api-keys') && keyPromptPaneLines('mistral-admin', null, 0, false).join(' ').includes('backoffice.mistral.ai'))
  check('no Vibe sign-in door exists anywhere in the family', !['Accounts', 'CallModel', 'Catalogue', 'Login', 'Pins', 'UsageState'].some(part => read(`src/services/providers/mistral/mistral${part}.ts`).toLowerCase().includes('vibe/sign-in')))
  check('the typed pins carry the vendor ids read on 2026-10-09 with their aliases and contexts', mistralDisplayPin('mistral-large-4')?.contextWindow === 1_048_576 && mistralDisplayPin('mistral-large-4-0')?.id === 'mistral-large-4' && mistralDisplayPin('mistral-medium-latest')?.id === 'mistral-medium-3-5' && mistralDisplayPin('mistral-large-latest')?.id === 'mistral-large-2512' && mistralDisplayPin('codestral-latest')?.contextWindow === 131_072 && MISTRAL_DISPLAY_PINS.every(pin => pin.observedAt === '2026-10-09'))
  check('retired ids are unknown like any other input', ['devstral-2512', 'magistral-medium-2509', 'mistral-medium-2508', 'mistral-large-2411', 'pixtral-large-2411'].every(id => mistralDisplayPin(id) === undefined))
  check('the chat-id shape excludes the embedding, OCR, moderation and audio rows', isMistralChatModelId('mistral-large-4') && isMistralChatModelId('ministral-3b-2512') && !isMistralChatModelId('mistral-embed') && !isMistralChatModelId('mistral-ocr-2505') && !isMistralChatModelId('mistral-moderation-2603') && isMistralModelId('mistral') && !isMistralModelId('mistralai/mistral-7b'))
  check('every pin prices through the family owner at the vendor list price', MISTRAL_DISPLAY_PINS.every(pin => resolveModelPricing(pin.id).costs?.inputTokens === pin.costInPerMtok && resolveModelPricing(pin.id).costs?.outputTokens === pin.costOutPerMtok) && resolveModelPricing('mistral-large-4').costs?.promptCacheReadTokens === 0.14)
  const dial = effortVocabularyFor('mistral-large-4')
  check('the effort dial is the vendor two-word dial, thinking-gated, off spelled none', dial.kind === 'provider' && dial.source === 'mistral' && dial.vocabulary.join(',') === 'none,high' && dial.thinkingGated && dial.thinkingOffWire === 'none' && effortVocabularyFor('codestral-2508').kind === 'none')
  check('both env spellings are in the strip table and the credential census', ['MISTRAL_API_KEY', 'MISTRAL_ADMIN_API_KEY'].every(name => ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name) && credentialEnvNames().includes(name)))
  process.env.MISTRAL_API_KEY = MISTRAL_FIXTURE_API_KEY
  const keyed = usageForProvider('mistral')
  check('a standard key reads API spend, says what unlocks the meter and names the console', keyed.sourceKind === 'api-key' && keyed.shape === 'api-spend' && keyed.windows.length === 0 && keyed.absence?.includes('Admin API key') && keyed.absence.includes('console.mistral.ai') && keyed.credits.state === 'unreported')
  check('the key makes Mistral usable, not another provider', resolveProviderUsability().mistral.usable && !resolveProviderUsability().meta.usable)
  const discovery = await refreshProviderDiscovery('mistral', { force: true })
  check('discovery records Mistral rather than falling through to another family', discovery?.provider === 'mistral' && discovery.keyPresent && discovery.keySource === 'env')
  const slots = deriveFamilySlotGroups().find(group => group.family.id === 'mistral')?.slots ?? []
  check('the key slot is the family\'s one active credential', slots.length === 1 && slots[0]?.kind === 'api-key' && slots[0].active && slots[0].envPinned)
  process.env.MERCURY_MISTRAL_API_BASE = fixture.base
  __resetMistralUsageForTest()
  await refreshProviderUsage('mistral', { force: true, reason: 'operator' })
  const identityOnly = mistralObservedUsage()
  check('a standard key reads its identity and nothing of the admin meter', identityOnly.identity?.email === 'fixture@example.invalid' && identityOnly.identity.organization === 'Fixture org' && identityOnly.limits === null && identityOnly.failure === null && !fixture.requests.some(request => request.path.startsWith('/v1/admin/')))
  check('the identity line names the account once it is read', usageForProvider('mistral').figures?.some(figure => figure.key === 'account' && figure.value === 'fixture@example.invalid (Fixture org / Fixture workspace)'))
  process.env.MISTRAL_ADMIN_API_KEY = MISTRAL_FIXTURE_ADMIN_KEY
  __resetMistralUsageForTest()
  await refreshProviderUsage('mistral', { force: true, reason: 'operator' })
  const metered = usageForProvider('mistral')
  const adminRequests = fixture.requests.filter(request => request.path.startsWith('/v1/admin/'))
  check('the admin key reads spend-limit and rate-limit with both documented header spellings and never the inference road', adminRequests.length === 2 && adminRequests.every(request => request.headers['x-api-key'] === MISTRAL_FIXTURE_ADMIN_KEY && request.headers.authorization === `Bearer ${MISTRAL_FIXTURE_ADMIN_KEY}`))
  check('the meter shows month-to-date usage against the monthly limit, the remainder as credits, the rate limit', metered.figures?.some(figure => figure.key === 'month-usage' && figure.value === 'EUR 45.00') && metered.figures.some(figure => figure.key === 'month-limit' && figure.value === 'EUR 500.00') && metered.figures.some(figure => figure.key === 'rate-limit' && figure.value === '6 requests/s') && metered.balance?.display === 'EUR 455.00 left of the monthly limit' && metered.credits.state !== 'unreported')
  const slotsWithAdmin = deriveFamilySlotGroups().find(group => group.family.id === 'mistral')?.slots ?? []
  check('the admin key is a usage-only slot beside the inference key, never active for dispatch', slotsWithAdmin.length === 2 && slotsWithAdmin.some(slot => slot.name === 'admin' && !slot.active && slot.stateNote?.includes('usage only')))
  fixture.state.adminStatus = 403
  __resetMistralUsageForTest()
  await refreshProviderUsage('mistral', { force: true, reason: 'operator' })
  const refused = usageForProvider('mistral')
  check('a refused admin key says so with the Backoffice remedy and keeps the identity', refused.readerNote?.includes('refused the Admin API key (HTTP 403)') && refused.readerNote.includes('backoffice.mistral.ai') && refused.figures?.some(figure => figure.key === 'account'))
  fixture.state.adminStatus = 200
  fixture.state.noMonthlyLimit = true
  __resetMistralUsageForTest()
  await refreshProviderUsage('mistral', { force: true, reason: 'operator' })
  const uncapped = usageForProvider('mistral')
  check('no monthly limit states usage as the figure and invents no remainder', uncapped.figures?.some(figure => figure.key === 'month-limit' && figure.value === 'none set') && uncapped.balance === undefined && uncapped.credits.compact === 'no limit set')
  const files = ['Accounts', 'CallModel', 'Catalogue', 'Login', 'Pins', 'UsageState'].map(part => `src/services/providers/mistral/mistral${part}.ts`)
  files.push('src/utils/router/providers/mistral.ts')
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
  check('the Mistral base is registered and pinned by the hermetic gate', read('src/substrate/flagRegistry.ts').includes("env: 'MERCURY_MISTRAL_API_BASE'") && read('scripts/gate/ci-shard.sh').includes('MERCURY_MISTRAL_API_BASE'))
  console.log(`MISTRAL CONTRACT GREEN (${count} checks; loopback fixture only)`)
} finally { fixture.stop(); rmSync(proofHome, { recursive: true, force: true }) }
