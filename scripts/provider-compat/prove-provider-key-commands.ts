import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'

const root = resolve(process.env.PLUMBING_PROOF_ROOT ?? join(import.meta.dir, '../..'))
const parent = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(parent, { recursive: true })
const scratch = realpathSync(mkdtempSync(join(parent, 'provider-key-commands-')))
const home = join(scratch, 'home')
const project = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(project, { recursive: true })
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

let nextKey = 'cmd-deepseek-first'
let rejectKey: string | null = null
const seenAuth: Array<{ path: string; auth: string }> = []
const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    const auth = request.headers.get('authorization') ?? request.headers.get('x-goog-api-key') ?? ''
    seenAuth.push({ path, auth })
    if (rejectKey && auth === `Bearer ${rejectKey}`) {
      return Response.json({ error: { message: 'rejected command key' } }, { status: 401 })
    }
    const body = (await request.json().catch(() => ({}))) as { model?: string }
    const usage = { prompt_tokens: 8, completion_tokens: 2 }
    return new Response(
      sse({ model: body.model ?? 'fixture', choices: [{ index: 0, delta: { content: 'KEY-COMMAND-SETTLED' }, finish_reason: null }] }) +
        sse({ model: body.model ?? 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }) +
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
const { setCwd } = await import(`${root}/src/utils/Shell.ts`)
const { setIsInteractive, setSessionTrustAccepted, setProjectRoot, setOriginalCwd } = await import(`${root}/src/bootstrap/state.ts`)
const { resetTrustDialogAcceptedCacheForTesting } = await import(`${root}/src/utils/config/trust.ts`)
const { resetSettingsCache } = await import(`${root}/src/utils/settings/settingsCache.ts`)
const { SettingsSchema } = await import(`${root}/src/utils/settings/types.ts`)
const { routedCallModel } = await import(`${root}/src/services/providers/callModelRouter.ts`)
const { createUserMessage } = await import(`${root}/src/utils/messages.ts`)
const { asSystemPrompt } = await import(`${root}/src/utils/systemPromptType.ts`)
const secrets = await import(`${root}/src/services/providers/providerSecrets.ts`)
const auth = await import(`${root}/src/utils/auth.ts`)
const keyCommandOwner = existsSync(`${root}/src/services/providers/providerKeyCommand.ts`)
  ? await import(`${root}/src/services/providers/providerKeyCommand.ts`)
  : undefined

setCwd(project)
setOriginalCwd(project)
setProjectRoot(project)
setIsInteractive(false)
setSessionTrustAccepted(true)

let checks = 0
let failures = 0
function check(name: string, pass: unknown) {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`)
}

const countFile = join(scratch, 'exec-count')
const helperScript = join(scratch, 'helper.mjs')
writeFileSync(
  helperScript,
  `import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(countFile)}, '1')
const state = JSON.parse(readFileSync(${JSON.stringify(join(scratch, 'helper-state.json'))}, 'utf8'))
if (state.cwdCheck && process.cwd() !== state.expectedCwd) { process.stderr.write('wrong cwd: ' + process.cwd()); process.exit(4) }
if (state.envCheck && process.env.NO_COLOR === '1' && process.env.USER_OWN_VAR !== 'kept') { process.stderr.write('tool shell env leaked'); process.exit(5) }
if (state.failCode) { process.stderr.write(state.stderr || 'command failed'); process.exit(state.failCode) }
process.stdout.write(state.key || '')
`,
)
const setHelperState = (state: Record<string, unknown>) => writeFileSync(join(scratch, 'helper-state.json'), JSON.stringify(state))
const cmdLine = `"${process.execPath}" "${helperScript}"`
const setSettings = (settings: Record<string, unknown>) => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings))
  resetSettingsCache()
  keyCommandOwner?.invalidateProviderKeyCommand()
  auth.clearApiKeyHelperCache()
}
const executions = (): number => (existsSync(countFile) ? readFileSync(countFile, 'utf8').length : 0)
const clearExecutions = () => rmSync(countFile, { force: true })

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
const prompt = [createUserMessage({ content: 'key command fixture' })]
async function run(model: string): Promise<any[]> {
  const out: any[] = []
  for await (const row of routedCallModel({
    messages: prompt,
    tools: [tool],
    systemPrompt: asSystemPrompt(['Key command fixture']),
    thinkingConfig: { type: 'adaptive' },
    signal: new AbortController().signal,
    options: { model, effortValue: 'max', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => ({}), agents: [], hasAppendSystemPrompt: false, mcpTools: [] },
  } as never)) {
    if (row.type === 'assistant') out.push(row)
  }
  return out
}

try {
  process.env.USER_OWN_VAR = 'kept'
  delete process.env.NO_COLOR
  const familyResolvers: Array<[string, () => string | undefined, () => void, () => void, string, string]> = [
    ['openai', () => require(`${root}/src/services/providers/openai/openaiAccounts.ts`).resolveOpenaiApiKey()?.key, () => secrets.writeStoredOpenaiApiKey('stored-openai'), () => secrets.writeStoredOpenaiApiKey(null), 'OPENAI_API_KEY', 'env-openai'],
    ['openrouter', () => require(`${root}/src/services/providers/openrouter/openrouterAccounts.ts`).resolveOpenrouterApiKey()?.key, () => secrets.writeStoredOpenrouterApiKey('stored-openrouter'), () => secrets.writeStoredOpenrouterApiKey(null), 'OPENROUTER_API_KEY', 'env-openrouter'],
    ['gemini', () => require(`${root}/src/services/providers/gemini/geminiAccounts.ts`).resolveGeminiApiKey()?.key, () => secrets.writeStoredGeminiApiKey('stored-gemini'), () => secrets.writeStoredGeminiApiKey(null), 'GEMINI_API_KEY', 'env-gemini'],
    ['moonshot', () => require(`${root}/src/services/providers/moonshot/moonshotAccounts.ts`).resolveMoonshotApiKey()?.key, () => secrets.writeStoredMoonshotApiKey('stored-moonshot'), () => secrets.writeStoredMoonshotApiKey(null), 'MOONSHOT_API_KEY', 'env-moonshot'],
    ['deepseek', () => require(`${root}/src/services/providers/deepseek/deepseekAccounts.ts`).resolveDeepseekApiKey()?.key, () => secrets.writeStoredDeepseekApiKey('stored-deepseek'), () => secrets.writeStoredDeepseekApiKey(null), 'DEEPSEEK_API_KEY', 'env-deepseek'],
    ['xai', () => require(`${root}/src/services/providers/xai/xaiAccounts.ts`).resolveXaiApiKey()?.key, () => secrets.writeStoredXaiApiKey('stored-xai'), () => secrets.writeStoredXaiApiKey(null), 'XAI_API_KEY', 'env-xai'],
    ['meta', () => require(`${root}/src/services/providers/meta/metaAccounts.ts`).resolveMetaRawApiKey()?.key, () => secrets.writeStoredMetaApiKey('stored-meta'), () => secrets.writeStoredMetaApiKey(null), 'MODEL_API_KEY', 'env-meta'],
    ['mistral', () => require(`${root}/src/services/providers/mistral/mistralAccounts.ts`).resolveMistralApiKey()?.key, () => secrets.writeStoredMistralApiKey('stored-mistral'), () => secrets.writeStoredMistralApiKey(null), 'MISTRAL_API_KEY', 'env-mistral'],
    ['nous', () => require(`${root}/src/services/providers/nous/nousAccounts.ts`).resolveNousApiKey()?.key, () => secrets.writeStoredNousApiKey('stored-nous'), () => secrets.writeStoredNousApiKey(null), 'NOUS_API_KEY', 'env-nous'],
    ['zen', () => require(`${root}/src/services/providers/zen/zenAccounts.ts`).resolveZenApiKey()?.key, () => secrets.writeStoredZenApiKey('stored-zen'), () => secrets.writeStoredZenApiKey(null), 'OPENCODE_API_KEY', 'env-zen'],
    ['minimax', () => require(`${root}/src/services/providers/minimax/minimaxAccounts.ts`).resolveMinimaxApiKey()?.key, () => secrets.writeStoredMinimaxApiKey('stored-minimax'), () => secrets.writeStoredMinimaxApiKey(null), 'MINIMAX_API_KEY', 'env-minimax'],
    ['together', () => require(`${root}/src/services/providers/together/togetherAccounts.ts`).resolveTogetherApiKey()?.key, () => secrets.writeStoredTogetherApiKey('stored-together'), () => secrets.writeStoredTogetherApiKey(null), 'TOGETHER_API_KEY', 'env-together'],
    ['cohere', () => require(`${root}/src/services/providers/cohere/cohereAccounts.ts`).resolveCohereApiKey()?.key, () => secrets.writeStoredCohereApiKey('stored-cohere'), () => secrets.writeStoredCohereApiKey(null), 'COHERE_API_KEY', 'env-cohere'],
    ['huggingface', () => require(`${root}/src/services/providers/huggingface/huggingfaceAccounts.ts`).resolveHuggingfaceApiKey()?.key, () => secrets.writeStoredHuggingfaceApiKey('stored-huggingface'), () => secrets.writeStoredHuggingfaceApiKey(null), 'HF_TOKEN', 'env-huggingface'],
    ['local', () => require(`${root}/src/services/providers/local/localAccounts.ts`).resolveLocalApiKey()?.key, () => secrets.writeStoredLocalApiKey('stored-local'), () => secrets.writeStoredLocalApiKey(null), 'MERCURY_LOCAL_API_KEY', 'env-local'],
    ['zai', () => (existsSync(`${root}/src/services/providers/zai/zaiAccounts.ts`) ? require(`${root}/src/services/providers/zai/zaiAccounts.ts`) : require(`${root}/src/services/providers/providerDiscovery.ts`)).resolveZaiDispatch()?.key, () => secrets.writeStoredZaiApiKey('stored-zai'), () => secrets.writeStoredZaiApiKey(null), 'ZAI_API_KEY', 'env-zai'],
  ]

  for (const [family, resolveKey, writeStored, clearStored, envName, envVal] of familyResolvers) {
    clearExecutions()
    setHelperState({ key: `cmd-${family}`, cwdCheck: true, expectedCwd: project, envCheck: true })
    writeStored()
    setSettings({ credentials: { keyCommands: { [family]: cmdLine } } })
    const resolvedCmd = resolveKey()
    const cachedSecond = resolveKey()
    const countAfterTwo = executions()
    process.env[envName] = envVal
    const resolvedEnv = resolveKey()
    delete process.env[envName]
    setSettings({})
    const resolvedStored = resolveKey()
    clearStored()
    check(
      `${family}: keyCommand runs in project dir with user env, caches in process, wins over stored key, and yields to ${envName}`,
      resolvedCmd === `cmd-${family}` && cachedSecond === `cmd-${family}` && countAfterTwo === 1 && resolvedEnv === envVal && resolvedStored === `stored-${family}`,
    )
  }

  clearExecutions()
  setHelperState({ key: 'cmd-compat-east', cwdCheck: true, expectedCwd: project })
  setSettings({
    compatProvider: {
      east: { baseUrl: `${origin}/east`, models: ['Fixture'], keyCommand: cmdLine },
    },
    credentials: {
      keyCommands: { zai: cmdLine },
    },
  })
  const compatAccounts = await import(`${root}/src/services/providers/openaicompat/compatAccounts.ts`)
  const providerDiscovery = await import(`${root}/src/services/providers/providerDiscovery.ts`)
  check('named custom endpoint resolves its own keyCommand and caches it', compatAccounts.resolveCompatApiKey(process.env, 'east')?.key === 'cmd-compat-east' && compatAccounts.resolveCompatApiKey(process.env, 'east')?.key === 'cmd-compat-east' && providerDiscovery.primeZaiDiscovery()?.keyPresent === true && executions() === 2)

  clearExecutions()
  nextKey = 'cmd-deepseek-expired'
  rejectKey = 'cmd-deepseek-expired'
  setHelperState({ key: nextKey })
  setSettings({ credentials: { keyCommands: { deepseek: cmdLine } } })
  const firstPrime = require(`${root}/src/services/providers/deepseek/deepseekAccounts.ts`).resolveDeepseekApiKey()?.key
  check('deepseek primes the first command key before the turn', firstPrime === 'cmd-deepseek-expired' && executions() === 1)
  setHelperState({ key: 'cmd-deepseek-rotated' })
  const rowsAfter401 = await run('deepseek-v4-pro')
  check(
    'a 401 invalidates the cached command key, re-runs keyCommand once, and settles on the rotated key',
    executions() === 2 && seenAuth.at(-1)?.auth === 'Bearer cmd-deepseek-rotated' && rowsAfter401.some(r => !r.isApiErrorMessage && r.message.content.some((b: any) => b.text === 'KEY-COMMAND-SETTLED')),
  )
  rejectKey = null

  console.log('refusals')
  clearExecutions()
  setHelperState({ failCode: 7, stderr: 'vault sealed' })
  setSettings({ credentials: { keyCommands: { deepseek: cmdLine, openrouter: cmdLine, openai: cmdLine } } })
  const failedResolve = require(`${root}/src/services/providers/deepseek/deepseekAccounts.ts`).resolveDeepseekApiKey()
  const backoffResolve = require(`${root}/src/services/providers/deepseek/deepseekAccounts.ts`).resolveDeepseekApiKey()
  const failedOpenrouterResolve = require(`${root}/src/services/providers/openrouter/openrouterAccounts.ts`).resolveOpenrouterApiKey()
  const failedOpenaiResolve = require(`${root}/src/services/providers/openai/openaiAccounts.ts`).resolveOpenaiApiKey()
  check('a failing keyCommand leaves the family with no key and backs off without re-running immediately', failedResolve === undefined && backoffResolve === undefined && failedOpenrouterResolve === undefined && failedOpenaiResolve === undefined && executions() === 3)
  const failedTurn = await run('deepseek-v4-pro')
  const failedOpenrouter = JSON.stringify(await run('openrouter/openai/gpt-5.6-terra'))
  const failedOpenai = JSON.stringify(await run('gpt-6-astra'))
  const failedText = JSON.stringify(failedTurn)
  check('a turn on a failed keyCommand names the command exit once and sends no request', failedText.includes('exited with code 7') && failedText.includes('vault sealed') && failedOpenrouter.includes('exited with code 7') && failedOpenai.includes('exited with code 7'))

  clearExecutions()
  const marker = join(project, 'untrusted-marker')
  rmSync(marker, { force: true })
  mkdirSync(join(project, '.mercury'), { recursive: true })
  writeFileSync(
    join(project, '.mercury', 'settings.json'),
    JSON.stringify({ credentials: { keyCommands: { deepseek: `touch "${marker}" && echo sk-untrusted` } } }),
  )
  setSettings({})
  setSessionTrustAccepted(false)
  resetTrustDialogAcceptedCacheForTesting()
  const untrustedKey = require(`${root}/src/services/providers/deepseek/deepseekAccounts.ts`).resolveDeepseekApiKey()
  setIsInteractive(true)
  const untrustedInteractive = require(`${root}/src/services/providers/deepseek/deepseekAccounts.ts`).resolveDeepseekApiKey()
  const untrustedConfigured = keyCommandOwner?.configuredProviderKeyCommand('deepseek')
  setIsInteractive(false)
  check('an untrusted project-scope keyCommand is refused and never executed', untrustedKey === undefined && untrustedInteractive === undefined && untrustedConfigured === undefined && !existsSync(marker))
  rmSync(join(project, '.mercury'), { recursive: true, force: true })
  setSessionTrustAccepted(true)
  resetTrustDialogAcceptedCacheForTesting()

  for (const bad of [{ credentials: { keyCommands: 'not-a-map' } }, { credentials: { keyCommands: { openai: 123 } } }, { compatProvider: { east: { baseUrl: 'https://example.com/v1', keyCommand: 42 } } }]) {
    const verdict = SettingsSchema().safeParse(bad)
    check(`malformed keyCommand setting is refused: ${JSON.stringify(bad)}`, !verdict.success)
  }

  console.log(`${failures ? 'PROVIDER KEY COMMANDS RED' : 'PROVIDER KEY COMMANDS GREEN'} (${checks} checks, ${failures} failures; loopback only)`)
} finally {
  globalThis.fetch = nativeFetch
  server.stop(true)
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
