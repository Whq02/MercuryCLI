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
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import(`${root}/src/services/providers/credentialEnvSpellings.ts`)
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

const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
enableConfigs()
await import(`${root}/src/services/resources/registry.ts`)
const { resetSettingsCache } = await import(`${root}/src/utils/settings/settingsCache.ts`)
const { SettingsSchema } = await import(`${root}/src/utils/settings/types.ts`)
const { getModelOptions } = await import(`${root}/src/utils/model/modelOptions.ts`)
const { liveModelsReference } = await import(`${root}/src/services/resources/adapters/models.ts`)
const { isBareFamilyWord, resolveBareFamilyWord } = await import(`${root}/src/utils/model/bareFamilyWords.ts`)
const { parseUserSpecifiedModel } = await import(`${root}/src/utils/model/model.ts`)
const { isModelAllowed } = await import(`${root}/src/utils/model/modelAllowlist.ts`)
const { validateModel } = await import(`${root}/src/utils/model/validateModel.ts`)
const { unrecognisedModelWordRefusal } = await import(`${root}/src/utils/crew/engineDispatch.ts`)
const { buildProviderSnapshot, resetProviderSnapshotMemo } = await import(`${root}/src/services/providers/modelRegistry.ts`)
const { routedCallModel } = await import(`${root}/src/services/providers/callModelRouter.ts`)
const { createUserMessage } = await import(`${root}/src/utils/messages.ts`)
const { asSystemPrompt } = await import(`${root}/src/utils/systemPromptType.ts`)
const secrets = await import(`${root}/src/services/providers/providerSecrets.ts`)
const disabledOwner = existsSync(`${root}/src/services/providers/disabledProviders.ts`)
  ? await import(`${root}/src/services/providers/disabledProviders.ts`)
  : undefined

let checks = 0
let failures = 0
function check(name: string, pass: unknown) {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`)
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
  check('before disabling, deepseek rows appear in the picker and bare word resolves', getModelOptions().some((o: any) => o.value === 'deepseek-v4-pro') && isBareFamilyWord('deepseek') && resolveBareFamilyWord('deepseek') === 'deepseek-v4-pro')

  setDisabled(['deepseek', 'not-a-family'])
  const optionsAfter = getModelOptions()
  check('disabling deepseek removes its rows and action rows from the picker while keeping other families', !optionsAfter.some((o: any) => o.value.includes('deepseek')) && optionsAfter.some((o: any) => o.value.includes('glm')))

  const pageAfter = await liveModelsReference({})
  check('disabling deepseek removes it from mercury://models while keeping zai', !pageAfter.providers.some((p: any) => p.provider === 'deepseek') && !pageAfter.notSignedIn.includes('DeepSeek') && pageAfter.providers.some((p: any) => p.provider === 'zai'))

  check('the disabled family bare word stops resolving and becomes unknown', !isBareFamilyWord('deepseek') && resolveBareFamilyWord('deepseek') === undefined && parseUserSpecifiedModel('deepseek') === 'deepseek')
  check('the stored key of a disabled provider remains untouched on disk', secrets.readStoredDeepseekApiKey() === 'sk-deepseek-kept')

  const snap = buildProviderSnapshot()
  const dsSnap = snap.providers.find((p: any) => p.id === 'deepseek')
  check('the provider registry marks a disabled provider unavailable with reason disabled:deepseek', dsSnap?.available === false && dsSnap?.reason === 'disabled:deepseek')

  const healthSummary = disabledOwner?.disabledProvidersHealthSummary()
  check('/health summary names the disabled provider and any unknown provider name once as info', healthSummary?.status === 'info' && healthSummary.evidence.includes('DeepSeek (deepseek)') && healthSummary.evidence.includes('not-a-family'))

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
  check('a session already on a disabled family model keeps running without hopping', out.some(r => !r.isApiErrorMessage && r.message.content.some((b: any) => b.text === 'STILL-RUNNING-SETTLED')))

  console.log('refusals')
  check('a disabled family model id is not allowed for selection', !isModelAllowed('deepseek-v4-pro') && !isModelAllowed('deepseek'))
  const validated = await validateModel('deepseek-v4-pro')
  check('typing a disabled family model id is treated as unknown / not found', !validated.valid && Boolean(validated.error?.includes('not found')))
  const bareValidated = await validateModel('deepseek')
  check('typing a disabled family bare word is treated as unknown / not found', !bareValidated.valid && Boolean(bareValidated.error?.includes('not found')))
  const crewRefusal = unrecognisedModelWordRefusal('deepseek')
  check('crew dispatch treats a disabled family bare word as an unrecognised word', crewRefusal !== null && crewRefusal.includes("names no model"))

  for (const bad of [{ engine: { disabledProviders: 'deepseek' } }, { engine: { disabledProviders: [123] } }]) {
    const verdict = SettingsSchema().safeParse(bad)
    check(`malformed engine.disabledProviders is refused: ${JSON.stringify(bad)}`, !verdict.success)
  }

  setDisabled(undefined)
  check('clearing engine.disabledProviders restores deepseek to the picker and bare word table', getModelOptions().some((o: any) => o.value === 'deepseek-v4-pro') && isBareFamilyWord('deepseek'))

  console.log(`${failures ? 'DISABLED PROVIDERS RED' : 'DISABLED PROVIDERS GREEN'} (${checks} checks, ${failures} failures; loopback only)`)
} finally {
  globalThis.fetch = nativeFetch
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
