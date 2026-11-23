import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'

const root = resolve(process.env.PLUMBING_PROOF_ROOT ?? join(import.meta.dir, '../..'))
const parent = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(parent, { recursive: true })
const home = mkdtempSync(join(parent, 'disabled-providers-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_AUTH_SCOPE_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import(`${root}/src/models/sign-in/credentials/credentialEnvSpellings.ts`)
for (const key of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[key]
for (const key of Object.keys(process.env)) if (/^MERCURY_COMPAT_/.test(key)) delete process.env[key]

const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const body = (await request.json().catch(() => ({}))) as { model?: string }
    const usage = { prompt_tokens: 5, completion_tokens: 2 }
    return new Response(
      sse({ model: body.model ?? 'deepseek-v4-pro', choices: [{ index: 0, delta: { content: 'STILL-RUNNING-SETTLED' }, finish_reason: null }] }) +
        sse({ model: body.model ?? 'deepseek-v4-pro', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }) +
        'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  },
})
const origin = `http://127.0.0.1:${server.port}`
process.env.MERCURY_DEEPSEEK_API_BASE = `${origin}/deepseek`
const nativeFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin !== origin) throw new Error(`non-loopback proof request refused: ${url.origin}`)
  return nativeFetch(input, init)
}) as typeof fetch

const { enableConfigs } = await import(`${root}/src/platform/settings/config.ts`)
enableConfigs()
await import(`${root}/src/integrations/resources/registry.ts`)
const { resetSettingsCache } = await import(`${root}/src/platform/settings/settingsCache.ts`)
const { SettingsSchema } = await import(`${root}/src/platform/settings/settingsSchema.ts`)
const { getModelOptions } = await import(`${root}/src/models/catalogue/modelOptions.ts`)
const { liveModelsReference } = await import(`${root}/src/integrations/resources/adapters/models.ts`)
const { isBareFamilyWord, resolveBareFamilyWord } = await import(`${root}/src/models/catalogue/bareFamilyWords.ts`)
const { parseUserSpecifiedModel } = await import(`${root}/src/models/catalogue/engineModel.ts`)
const { isModelAllowed } = await import(`${root}/src/models/catalogue/modelAllowlist.ts`)
const { validateModel } = await import(`${root}/src/models/roads/validateModel.ts`)
const { unrecognisedModelWordRefusal } = await import(`${root}/src/crew/crewmates/engineDispatch.ts`)
const { buildProviderSnapshot, resetProviderSnapshotMemo } = await import(`${root}/src/models/roads/modelRegistry.ts`)
const { routedCallModel } = await import(`${root}/src/models/roads/callModelRouter.ts`)
const { createUserMessage } = await import(`${root}/src/engine/messages/messages.ts`)
const { asSystemPrompt } = await import(`${root}/src/engine/system-prompt/systemPromptType.ts`)
const secrets = await import(`${root}/src/models/sign-in/account-ledger/providerSecrets.ts`)
const disabledOwner = existsSync(`${root}/src/models/roads/disabledProviders.ts`)
  ? await import(`${root}/src/models/roads/disabledProviders.ts`)
  : undefined

let checks = 0
let failures = 0
function check(name: string, pass: unknown, detail?: string) {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${!pass && detail ? ` -- ${detail}` : ''}`)
}

const setDisabled = (disabledProviders?: unknown) => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify(disabledProviders === undefined ? {} : { engine: { disabledProviders } }))
  resetSettingsCache()
  resetProviderSnapshotMemo()
}

const tool = {
  name: 'FixtureEcho',
  description: async () => 'Echo fixture',
  prompt: async () => 'Echo fixture',
  inputSchema: z.object({ text: z.string() }),
  userFacingName: () => 'FixtureEcho',
  isEnabled: () => true,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isMcp: false,
  needsPermissions: () => false,
} as never

try {
  secrets.writeStoredDeepseekApiKey('sk-deepseek-kept')
  secrets.writeStoredZaiApiKey('sk-zai-kept')

  setDisabled(undefined)
  check('before disabling, deepseek rows appear in the picker and bare word resolves', getModelOptions().some((o: any) => o.value === 'deepseek-v4-pro') && isBareFamilyWord('deepseek') && resolveBareFamilyWord('deepseek') === 'deepseek-v4-pro', 'with no engine.disabledProviders set the deepseek rows and bare word must stay available: check getModelOptions in src/models/catalogue/modelOptions.ts and bareFamilyWords.ts')

  setDisabled(['deepseek', 'not-a-family'])
  const optionsAfter = getModelOptions()
  check('disabling deepseek removes its rows and action rows from the picker while keeping other families', !optionsAfter.some((o: any) => o.value.includes('deepseek')) && optionsAfter.some((o: any) => o.value.includes('glm')), 'getModelOptions in src/models/catalogue/modelOptions.ts must drop rows of a provider listed in engine.disabledProviders (isProviderDisabled in src/models/roads/disabledProviders.ts) and keep the others')

  const pageAfter = await liveModelsReference({})
  check('disabling deepseek removes it from mercury://models while keeping zai', !pageAfter.providers.some((p: any) => p.provider === 'deepseek') && !pageAfter.notSignedIn.includes('DeepSeek') && pageAfter.providers.some((p: any) => p.provider === 'zai'), 'liveModelsReference in src/integrations/resources/adapters/models.ts must skip a disabled provider in providers and notSignedIn and keep zai')

  check('the disabled family bare word stops resolving and becomes unknown', !isBareFamilyWord('deepseek') && resolveBareFamilyWord('deepseek') === undefined && parseUserSpecifiedModel('deepseek') === 'deepseek', 'isBareFamilyWord and resolveBareFamilyWord in src/models/catalogue/bareFamilyWords.ts must ignore a disabled family, and the word must then pass through parseUserSpecifiedModel unchanged')
  check('the stored key of a disabled provider remains untouched on disk', secrets.readStoredDeepseekApiKey() === 'sk-deepseek-kept', 'disabling a provider must not touch its stored key: nothing in src/models/roads/disabledProviders.ts or its callers may clear it from src/models/sign-in/account-ledger/providerSecrets.ts')

  const snap = buildProviderSnapshot()
  const dsSnap = snap.providers.find((p: any) => p.id === 'deepseek')
  check('the provider registry marks a disabled provider unavailable with reason disabled:deepseek', dsSnap?.available === false && dsSnap?.reason === 'disabled:deepseek', `buildProviderSnapshot in src/models/roads/modelRegistry.ts must mark a disabled provider available false with reason disabled:deepseek, got ${JSON.stringify(dsSnap)}`)

  const healthSummary = disabledOwner?.disabledProvidersHealthSummary()
  check('/health summary names the disabled provider and any unknown provider name once as info', healthSummary?.status === 'info' && healthSummary.evidence.includes('DeepSeek (deepseek)') && healthSummary.evidence.includes('not-a-family'), `disabledProvidersHealthSummary in src/models/roads/disabledProviders.ts must return status info naming each disabled provider and each unknown name, got ${JSON.stringify(healthSummary)}`)

  const out: any[] = []
  for await (const row of routedCallModel({
    messages: [createUserMessage({ content: 'keep running' })],
    tools: [tool],
    systemPrompt: asSystemPrompt(['Disabled provider running session']),
    thinkingConfig: { type: 'adaptive' },
    signal: new AbortController().signal,
    options: { model: 'deepseek-v4-pro', effortValue: 'max', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [] },
  } as never)) {
    if (row.type === 'assistant') out.push(row)
  }
  check('a session already on a disabled family model keeps running without hopping', out.some(r => !r.isApiErrorMessage && r.message.content.some((b: any) => b.text === 'STILL-RUNNING-SETTLED')), 'routedCallModel in src/models/roads/callModelRouter.ts must still serve a model of a disabled family without hopping to another provider')

  console.log('refusals')
  check('a disabled family model id is not allowed for selection', !isModelAllowed('deepseek-v4-pro') && !isModelAllowed('deepseek'), 'isModelAllowed in src/models/catalogue/modelAllowlist.ts must refuse a model id and a bare word of a disabled provider')
  const validated = await validateModel('deepseek-v4-pro')
  check('typing a disabled family model id is treated as unknown / not found', !validated.valid && Boolean(validated.error?.includes('not found')), `validateModel in src/models/roads/validateModel.ts must answer not found for a disabled family model id, got ${JSON.stringify(validated)}`)
  const bareValidated = await validateModel('deepseek')
  check('typing a disabled family bare word is treated as unknown / not found', !bareValidated.valid && Boolean(bareValidated.error?.includes('not found')), `validateModel in src/models/roads/validateModel.ts must answer not found for a disabled family bare word, got ${JSON.stringify(bareValidated)}`)
  const crewRefusal = unrecognisedModelWordRefusal('deepseek')
  check('crew dispatch treats a disabled family bare word as an unrecognised word', crewRefusal !== null && crewRefusal.includes("names no model"), `unrecognisedModelWordRefusal in src/crew/crewmates/engineDispatch.ts must refuse a disabled family bare word with a text saying it names no model, got ${JSON.stringify(crewRefusal)}`)

  for (const bad of [{ engine: { disabledProviders: 'deepseek' } }, { engine: { disabledProviders: [123] } }]) {
    const verdict = SettingsSchema().safeParse(bad)
    check(`malformed engine.disabledProviders is refused: ${JSON.stringify(bad)}`, !verdict.success, 'the engine.disabledProviders field in SettingsSchema (src/platform/settings/settingsSchema.ts) must accept only an array of strings')
  }

  setDisabled(undefined)
  check('clearing engine.disabledProviders restores deepseek to the picker and bare word table', getModelOptions().some((o: any) => o.value === 'deepseek-v4-pro') && isBareFamilyWord('deepseek'), 'removing engine.disabledProviders must bring the deepseek rows and bare word back: the settings cache reset must reach getModelOptions (src/models/catalogue/modelOptions.ts) and bareFamilyWords.ts')

  console.log(`${failures ? 'DISABLED PROVIDERS RED' : 'DISABLED PROVIDERS GREEN'} (${checks} checks, ${failures} failures; loopback only)`)
} finally {
  globalThis.fetch = nativeFetch
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
