#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
writeFileSync(join(proofHome, 'settings.json'), '{}\n')

const REPO = resolve(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const walkFiles = (dir: string, re: RegExp): string[] => readdirSync(dir).flatMap(entry => {
  if (entry === '.out' || entry === 'node_modules' || entry === 'dist') return []
  const path = join(dir, entry)
  if (statSync(path).isDirectory()) return walkFiles(path, re)
  return re.test(entry) && !entry.endsWith('.d.ts') ? [path] : []
})
const productFiles = (dir: string): string[] => walkFiles(dir, /\.tsx?$/)
const RETIRED_ENVS = ['MERCURY_ROUTER', 'MERCURY_ROUTER_POSTURE', 'MERCURY_ROUTER_STATE_DIR', 'MERCURY_MISSION_POLICY']
const RETIRED_POSTURES = ['adaptive', 'quality', 'balanced', 'fast', 'fixed']
const OLD_ROUTER_REL = join('utils', 'router')
const POSTURE_FILENAME = `${'posture'}.json`

console.log('entering a provider key has one home: /logins')

{
  console.log('\nthe flags and route-store retirement')
  const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
  for (const env of RETIRED_ENVS) {
    check(`the flag registry carries no row for ${env}`, !FLAG_REGISTRY.some(row => row.env === env))
  }
  const spellings = new Map<string, string[]>()
  for (const path of productFiles(join(REPO, 'src'))) {
    const text = readFileSync(path, 'utf8')
    for (const env of RETIRED_ENVS) if (text.includes(env)) spellings.set(env, [...(spellings.get(env) ?? []), relative(REPO, path)])
  }
  check('no product file spells a retired flag', spellings.size === 0, [...spellings].map(([env, paths]) => `${env}: ${paths.join(', ')}`).join(' · '))
  const stalePathHits: string[] = []
  for (const root of ['src', 'scripts', 'docs']) {
    for (const path of walkFiles(join(REPO, root), /\.(?:tsx?|md|sh|json)$/)) {
      if (readFileSync(path, 'utf8').includes(OLD_ROUTER_REL)) stalePathHits.push(relative(REPO, path))
    }
  }
  check('zero files in src, scripts or docs spell the old provider path', stalePathHits.length === 0, stalePathHits.slice(0, 8).join(', '))
  const homeStores = await import('../../src/utils/projectHomeStores.ts')
  check('the project home stores carry no route-state store (a folder left on disk is never read)', !homeStores.PROJECT_HOME_STORES.some(segments => segments.join('/') === 'router'))
  const storeRepo = realpathSync(mkdtempSync(join(tmpdir(), 'retired-route-store-')))
  try {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: storeRepo, encoding: 'utf8' })
    git('init', '-q')
    const folderStore = join(storeRepo, '.mercury', 'router')
    mkdirSync(folderStore, { recursive: true })
    writeFileSync(join(folderStore, POSTURE_FILENAME), JSON.stringify({ posture: 'quality', pin: 'opus', updatedAt: 123 }))
    writeFileSync(join(folderStore, 'plans.json'), JSON.stringify({ _v: 1, plans: [{ id: 'rp-1', state: 'running', revision: 1, mode: 'fanout', title: 't', objective: 'o', profile: 'routed-wide', nodes: [], synthesis: { required: false, owner: 'planner', acceptance: [] }, decision: { policyVersion: 'v1', source: 'structured-intent', posture: 'quality', selectedProfile: 'routed-wide', selectedModels: [], decisiveReasons: [], displayReasons: [], adjustments: [] }, createdAt: 1, updatedAt: 1 }], events: [], updatedAt: 123 }))
    writeFileSync(join(folderStore, 'outcomes.json'), JSON.stringify({ _v: 1, rows: [{ profileId: 'routed-wide', accepted: true, at: 123 }] }))
    git('add', '.')
    git('-c', 'user.email=p@p', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed retired store')
    const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
    const homeRouterDir = join(getProjectDir(storeRepo), 'router')
    const leftovers = homeStores.projectHomeLeftovers(storeRepo)
    const prevHealthDir = process.env.MERCURY_HEALTH_STATE_DIR
    process.env.MERCURY_HEALTH_STATE_DIR = storeRepo
    const { projectEstateCheck } = await import('../../src/utils/healthReport.ts')
    const estate = await projectEstateCheck()
    if (prevHealthDir === undefined) delete process.env.MERCURY_HEALTH_STATE_DIR
    else process.env.MERCURY_HEALTH_STATE_DIR = prevHealthDir
    check('a route-store or posture file left in .mercury/router is never listed as a leftover or migrated to the home store', !leftovers.includes('.mercury/router') && !existsSync(homeRouterDir) && estate.status === 'ok' && !(estate.evidence ?? '').includes('router'), JSON.stringify({ leftovers, estate }))
  } finally {
    rmSync(storeRepo, { recursive: true, force: true })
  }
}

{
  console.log('\nthe key entry: every family the old board carried has its /logins row, key leg and slot switch')
  const { parseFamilyFocus } = await import('../../src/commands/login/login.tsx')
  const { anthropicArmPickRows, loginFamilyRows, openaiArmPickRows } = await import('../../src/components/loginFamilyRows.ts')
  const rows = loginFamilyRows({ engineLegs: true }).map(row => row.value)
  const flow = readFileSync(join(REPO, 'src/components/ConsoleOAuthFlow.tsx'), 'utf8')
  const legs = /type EngineLeg =([\s\S]*?)\n\n/.exec(flow)?.[1] ?? ''
  for (const [word, family] of [['zai', 'zai'], ['moonshot', 'moonshot'], ['deepseek', 'deepseek'], ['xai', 'xai'], ['meta', 'meta'], ['huggingface', 'huggingface'], ['mistral', 'mistral'], ['nous', 'nous'], ['zen', 'zen']] as const) {
    check(`/logins ${word} focuses the ${family} row, which the catalogue carries and the card has a leg for`, parseFamilyFocus(word) === family && rows.includes(family) && legs.includes(`'${family}'`))
  }
  const openaiConnectExists = existsSync(join(REPO, 'src/components/OpenaiConnect.tsx'))
  const openrouterConnectExists = existsSync(join(REPO, 'src/components/OpenrouterConnect.tsx'))
  const geminiConnect = readFileSync(join(REPO, 'src/components/GeminiConnect.tsx'), 'utf8')
  check('/logins carries the Anthropic, OpenAI, OpenRouter and Gemini key legs alongside their sign-in legs', parseFamilyFocus('anthropic') === 'anthropic' && parseFamilyFocus('console') === 'anthropic' && rows.includes('anthropic') && anthropicArmPickRows.map(r => r.value).join(',') === 'claudeai,console' && legs.includes("'anthropic'") && parseFamilyFocus('openai') === 'openai' && rows.includes('openai') && openaiArmPickRows.some(r => r.value === 'key') && openaiConnectExists && parseFamilyFocus('openrouter') === 'openrouter' && rows.includes('openrouter') && openrouterConnectExists && parseFamilyFocus('gemini') === 'gemini' && rows.includes('gemini') && geminiConnect.includes('storeGeminiApiKeyLogin'))
  const xai = readFileSync(join(REPO, 'src/components/XaiConnect.tsx'), 'utf8')
  check('/logins xai carries the management key as its second step', xai.includes("setStep('management')") && xai.includes('storeXaiManagementKeyLogin'))
  const mistral = readFileSync(join(REPO, 'src/components/MistralConnect.tsx'), 'utf8')
  check('/logins mistral carries the Admin API key beside the inference key', mistral.includes('storeMistralAdminKeyLogin') || mistral.includes('Admin API key'))
  const bootLogins = readFileSync(join(REPO, 'src/components/BootLoginsScreen.tsx'), 'utf8')
  const { switchActiveSlot, slotSeatView } = await import('../../src/services/providers/slotSwitch.ts')
  const dualOpenaiReads = {
    openaiSubscription: () => ({ label: 'ChatGPT plus subscription' }),
    openaiKey: () => ({ source: 'stored' as const }),
    openaiActiveKind: () => 'chatgpt-subscription' as const,
    openaiWallOf: () => ({ state: 'clear' as const }),
  }
  let writtenOpenaiPref: string | null = null
  const switched = switchActiveSlot('openai', {
    reads: dualOpenaiReads,
    writes: {
      writeOpenaiPreference: pref => { writtenOpenaiPref = pref },
      writeAnthropicPreference: () => {},
      resetAnthropicLimits: () => {},
      clearAuthHeaderCaches: () => {},
    },
  })
  check('/logins wires the s slot switch on a family row to switchActiveSlot, flipping between subscription and API key', bootLogins.includes('switchActiveSlot(') && slotSeatView('openai', dualOpenaiReads).other?.kind === 'api-key' && switched.switched && writtenOpenaiPref === 'api-key')
  const { reconnectDoorFor } = await import('../../src/services/providers/credentialWall.ts')
  check('the custom endpoint and the local server name their key variable (no sign-in leg exists for them)', reconnectDoorFor('openai-compat') === 'MERCURY_COMPAT_API_KEY' && reconnectDoorFor('local') === 'MERCURY_LOCAL_API_KEY')
  const search = await import('../../src/services/search/searchContract.ts')
  check('the web-search key door names the two variables', search.KEYED_DOOR_COMMANDS === 'BRAVE_API_KEY · TAVILY_API_KEY')
}

{
  console.log('\nthe move: stored-key byte survival, adapters without posture, and request-bytes control')
  const movedSecretsPath = join(REPO, 'src/services/providers/providerSecrets.ts')
  const movedRegistryPath = join(REPO, 'src/services/providers/modelRegistry.ts')
  check('providerSecrets and modelRegistry live under src/services/providers/', existsSync(movedSecretsPath) && existsSync(movedRegistryPath))
  if (existsSync(movedSecretsPath) && existsSync(movedRegistryPath)) {
    const secretsFile = join(proofHome, '.provider-secrets.json')
    const seededPayload = `${JSON.stringify({
      version: 1,
      zaiApiKey: 'zai-stored-key-0001',
      zaiKeyPlan: 'coding',
      moonshotApiKey: 'moonshot-stored-key-0002',
      deepseekApiKey: 'deepseek-stored-key-0003',
      xaiApiKey: 'xai-stored-key-0004',
      xaiManagementApiKey: 'xai-mgmt-stored-key-0005',
      metaApiKey: 'meta-stored-key-0006',
      huggingfaceApiKey: 'hf-stored-key-0007',
      mistralApiKey: 'mistral-stored-key-0008',
      mistralAdminApiKey: 'mistral-admin-stored-key-0009',
      nousApiKey: 'nous-stored-key-0010',
      zenApiKey: 'zen-stored-key-0011',
      compatApiKey: 'compat-stored-key-0012',
      localApiKey: 'local-stored-key-0013',
      braveSearchApiKey: 'brave-stored-key-0014',
      tavilyApiKey: 'tavily-stored-key-0015',
    }, null, 2)}\n`
    writeFileSync(secretsFile, seededPayload, { mode: 0o600 })
    const shaBefore = createHash('sha256').update(readFileSync(secretsFile)).digest('hex')
    const secrets = await import(movedSecretsPath)
    const { resolveCompatApiKey } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
    const { resolveLocalApiKey } = await import('../../src/services/providers/local/localAccounts.ts')
    const { resolveBraveSearchApiKey } = await import('../../src/services/search/brave.ts')
    const { resolveTavilyApiKey } = await import('../../src/services/search/tavily.ts')
    const allMatch =
      secrets.readStoredZaiApiKey() === 'zai-stored-key-0001' &&
      secrets.readStoredZaiKeyPlan() === 'coding' &&
      secrets.readStoredMoonshotApiKey() === 'moonshot-stored-key-0002' &&
      secrets.readStoredDeepseekApiKey() === 'deepseek-stored-key-0003' &&
      secrets.readStoredXaiApiKey() === 'xai-stored-key-0004' &&
      secrets.readStoredXaiManagementApiKey() === 'xai-mgmt-stored-key-0005' &&
      secrets.readStoredMetaApiKey() === 'meta-stored-key-0006' &&
      secrets.readStoredHuggingfaceApiKey() === 'hf-stored-key-0007' &&
      secrets.readStoredMistralApiKey() === 'mistral-stored-key-0008' &&
      secrets.readStoredMistralAdminApiKey() === 'mistral-admin-stored-key-0009' &&
      secrets.readStoredNousApiKey() === 'nous-stored-key-0010' &&
      secrets.readStoredZenApiKey() === 'zen-stored-key-0011' &&
      resolveCompatApiKey({} as NodeJS.ProcessEnv)?.key === 'compat-stored-key-0012' &&
      resolveLocalApiKey({} as NodeJS.ProcessEnv)?.key === 'local-stored-key-0013' &&
      resolveBraveSearchApiKey({} as NodeJS.ProcessEnv)?.key === 'brave-stored-key-0014' &&
      resolveTavilyApiKey({} as NodeJS.ProcessEnv)?.key === 'tavily-stored-key-0015'
    const shaAfter = createHash('sha256').update(readFileSync(secretsFile)).digest('hex')
    check('a key written in the base store format for every key-leg family and all four env-road FORK lanes is read byte for byte with sha256 unchanged', allMatch && shaBefore === shaAfter && (statSync(secretsFile).mode & 0o777) === 0o600)
    rmSync(secretsFile, { force: true })

    const registry = await import(movedRegistryPath)
    const anthropicAdapter = await import('../../src/services/providers/anthropic/anthropicAdapter.ts')
    const zaiAdapter = await import('../../src/services/providers/zai/zaiAdapter.ts')
    registry.resetProviderSnapshotMemo()
    const snap = registry.buildProviderSnapshot()
    const opusRef = snap.resolve('opus')
    const sonnetRef = snap.resolve('sonnet')
    const fableRef = snap.resolve('fable')
    let zaiThrow = ''
    try {
      zaiAdapter.zaiProviderAdapter.buildLaunchPatch({ provider: 'zai', model: 'glm-5.3', modelClass: 'glm', effort: 'high', contextWindow: 200_000 })
    } catch (e) {
      zaiThrow = e instanceof Error ? e.message : String(e)
    }
    check('buildProviderSnapshot resolves opus (xhigh), sonnet (high) and fable (high) without a posture argument, reaches max on Opus, and non-seat buildLaunchPatch throws seat: …', snap.providers.length === 24 && ['melious', 'orcarouter'].every(id => snap.providers.some(provider => provider.id === id)) && anthropicAdapter.resolveAnthropicModel.length === 1 && opusRef?.effort === 'xhigh' && sonnetRef?.effort === 'high' && fableRef?.effort === 'high' && anthropicAdapter.routeEffortsFor(opusRef.model).includes('max') && zaiThrow.startsWith('seat:'))
  }
  const { configureEffortParams } = await import('../../src/services/providers/anthropic/requestParams.ts')
  const { buildOpenaiResponsesRequest } = await import('../../src/services/providers/openai/responsesBridge.ts')
  const { buildZaiChatRequest } = await import('../../src/services/providers/zai/zaiCodec.ts')
  const { buildMistralExtras } = await import('../../src/services/providers/mistral/mistralCallModel.ts')
  const { buildMetaExtras } = await import('../../src/services/providers/meta/metaCallModel.ts')
  const { nousLaneProfile } = await import('../../src/services/providers/nous/nousCallModel.ts')
  const { buildZenExtras } = await import('../../src/services/providers/zen/zenCallModel.ts')
  const { buildMoonshotExtras, buildDeepseekExtras, buildOpenrouterExtras, buildXaiExtras, buildCompatSlotExtras, buildHuggingfaceExtras, buildGeminiExtras, buildLocalExtras } = await import('../../src/services/providers/openaicompat/compatWire.ts')
  const args = { wireModel: 'fixture-model', effortValue: 'high', thinkingEnabled: true, maxOutputTokensOverride: 256 }
  const anthropicOut: Record<string, unknown> = {}
  configureEffortParams('high', anthropicOut as never, {}, 'claude-opus-5-5')
  check(
    'request-bytes control: Anthropic, OpenAI, Gemini, Z.AI, compat and every sibling adapter build byte-identical request knobs',
    JSON.stringify(anthropicOut) === '{"effort":"high"}' &&
      JSON.stringify(buildOpenaiResponsesRequest({ model: 'gpt-6-astra', instructions: 'sys', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high', promptCacheKey: 'sess-1' })) === '{"model":"gpt-6-astra","instructions":"sys","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"reasoning":{"effort":"high","summary":"auto"},"store":false,"stream":true,"include":["reasoning.encrypted_content"],"prompt_cache_key":"sess-1"}' &&
      JSON.stringify(buildGeminiExtras({ ...args, acceptsEffort: true })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_tokens":256}' &&
      JSON.stringify(buildZaiChatRequest({ model: 'glm-5.3', system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 256, reasoningEffort: 'high', thinkingEnabled: true })) === '{"model":"glm-5.3","messages":[{"role":"system","content":"sys"},{"role":"user","content":"hi"}],"max_tokens":256,"reasoning_effort":"high","thinking":{"type":"enabled"}}' &&
      JSON.stringify(buildCompatSlotExtras(args)) === '{"stream_options":{"include_usage":true},"max_tokens":256}' &&
      JSON.stringify(buildMistralExtras({ ...args, wireModel: 'mistral-large-4' })) === '{"reasoning_effort":"high","max_tokens":256}' &&
      JSON.stringify(buildMetaExtras({ ...args, wireModel: 'muse-spark-1.3' })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}' &&
      JSON.stringify(nousLaneProfile.buildExtras({ ...args, wireModel: 'anthropic/claude-sonnet-4.6' })) === '{"stream_options":{"include_usage":true},"max_tokens":256}' &&
      JSON.stringify(buildZenExtras({ ...args, wireModel: 'glm-5.3' })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}' &&
      JSON.stringify(buildMoonshotExtras({ ...args, wireModel: 'kimi-k3' })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}' &&
      JSON.stringify(buildDeepseekExtras({ ...args, wireModel: 'deepseek-v4-pro' })) === '{"thinking":{"type":"enabled"},"reasoning_effort":"high","stream_options":{"include_usage":true},"max_tokens":256}' &&
      JSON.stringify(buildOpenrouterExtras({ ...args, vocabulary: ['low', 'high'] })) === '{"stream_options":{"include_usage":true},"reasoning":{"effort":"high"},"max_tokens":256}' &&
      JSON.stringify(buildXaiExtras({ ...args, vocabulary: ['low', 'high'] })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}' &&
      JSON.stringify(buildHuggingfaceExtras(args)) === '{"stream_options":{"include_usage":true},"max_tokens":256}' &&
      JSON.stringify(buildLocalExtras({ ...args, server: 'ollama', acceptsEffort: true })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_tokens":256}',
  )
}

{
  console.log('\nthe planner: session model law across /run, mercury://mission, the lanes rail and current work')
  const { composeMissionView, buildMissionRow } = await import('../../src/services/mission/projection.ts')
  const view = composeMissionView({
    workspace: '/tmp/proj',
    runObjective: 'ship the retirement',
    runLifecycle: 'active',
    snapshot: null,
    memoryRefs: [],
    executions: [],
    evidenceDigest: null,
    model: 'claude-fable-5-1',
    now: 1000,
    plans: [],
    posture: 'quality',
    nodeAttemptCeiling: 3,
  } as never)
  const row = buildMissionRow(view)
  check(
    "composeMissionView and buildMissionRow record the session's model with no plan, posture or profile",
    view !== null &&
      (view.policy as { model?: string; source?: string }).model === 'claude-fable-5-1' &&
      (view.policy as { source?: string }).source === 'session-model' &&
      !('plans' in view) &&
      !('replan' in view) &&
      !('posture' in view.policy) &&
      !('profile' in view.policy) &&
      row?.line === 'claude-fable-5-1 · goal[run-objective]' &&
      row.detail.some(d => d === 'model: claude-fable-5-1 (the session model)'),
    JSON.stringify({ view, row }),
  )
  const missionAdapterSrc = readFileSync(join(REPO, 'src/services/resources/adapters/mission.ts'), 'utf8')
  const helmLanesSrc = readFileSync(join(REPO, 'src/utils/cockpit/helmLanesModel.ts'), 'utf8')
  const { deriveCurrentWork } = await import('../../src/services/workbench/currentWork.ts')
  const cw = deriveCurrentWork({
    now: 1000,
    owner: { id: 'main', kind: 'main', label: 'main' } as never,
    run: null,
    workbench: null,
    model: 'claude-fable-5-1',
    effortLabel: 'high',
    contextPct: 10,
    recovery: { state: 'none' },
  } as never)
  check(
    'mercury://mission has no plans child, the lanes rail paints no via <profile> line, and currentWork carries no executionShape',
    !missionAdapterSrc.includes('child=plans') &&
      missionAdapterSrc.includes("the session's model") &&
      !helmLanesSrc.includes('workShape') &&
      !helmLanesSrc.includes('via ${') &&
      !('executionShape' in cw),
  )
}

{
  console.log('\nthe health certificate and the refusal law across environment, settings and session files')
  const report = await import('../../src/utils/healthReport.ts')
  const sectionIds = (cert: Awaited<ReturnType<typeof report.runHealthReport>>): string[] => cert.sections.map(s => s.id)
  const plain = await report.runHealthReport({ depth: 'fast' })
  check('no section of the certificate is the route section', !sectionIds(plain).includes('router-fast') && !plain.sections.some(s => s.title === 'ROUTER'))
  check('no check id begins with the retired word', !plain.sections.flatMap(s => s.checks).some(c => c.id.startsWith('router-')))
  const slots = plain.sections.flatMap(s => s.checks).find(c => c.id === 'provider-slots')
  check('the provider honesty row lives on under AUTH', slots !== undefined && plain.sections.find(s => s.id === 'auth')?.checks.some(c => c.id === 'provider-slots') === true)
  for (const env of RETIRED_ENVS) process.env[env] = env === 'MERCURY_ROUTER_POSTURE' ? RETIRED_POSTURES[1]! : env === 'MERCURY_MISSION_POLICY' ? 'specialist-sol' : '0'
  const pinned = await report.runHealthReport({ depth: 'fast' })
  for (const env of RETIRED_ENVS) delete process.env[env]
  check('a retired flag set in the environment is an unknown input: the certificate keeps its sections', sectionIds(pinned).join('|') === sectionIds(plain).join('|'), sectionIds(pinned).join('|'))
  const words = pinned.sections.flatMap(s => s.checks).map(c => `${c.evidence ?? ''} ${c.fix ?? ''}`).join('\n')
  check('…and no row answers it with a refusal sentence or names it', !RETIRED_ENVS.some(env => words.includes(env)))

  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
  const { getSettingsWithAllErrors } = await import('../../src/utils/settings/allErrors.ts')
  const { applyConfigEnvironmentVariables } = await import('../../src/utils/managedEnv.ts')
  writeFileSync(
    join(proofHome, 'settings.json'),
    JSON.stringify({
      environment: {
        values: {
          MERCURY_ROUTER: '0',
          MERCURY_ROUTER_POSTURE: RETIRED_POSTURES[1],
          MERCURY_ROUTER_STATE_DIR: '/tmp/retired-router',
          MERCURY_MISSION_POLICY: 'specialist-sol',
        },
      },
    }),
  )
  resetSettingsCache()
  const envSettings = getSettingsWithAllErrors()
  applyConfigEnvironmentVariables()
  const settingsCert = await report.runHealthReport({ depth: 'fast' })
  for (const env of RETIRED_ENVS) delete process.env[env]
  writeFileSync(join(proofHome, 'settings.json'), '{}\n')
  resetSettingsCache()
  const plainFlagsCheck = plain.sections.flatMap(s => s.checks).find(c => c.id === 'flags')
  const settingsCheck = settingsCert.sections.flatMap(s => s.checks).find(c => c.id === 'settings')
  const flagsCheck = settingsCert.sections.flatMap(s => s.checks).find(c => c.id === 'flags')
  const settingsCertWords = settingsCert.sections.flatMap(s => s.checks).map(c => `${c.evidence ?? ''} ${c.fix ?? ''}`).join('\n')
  check(
    'a settings.json carrying retired flags or postures in environment.values is ignored without a validation error, override row or refusal sentence',
    envSettings.errors.length === 0 &&
      settingsCheck?.status === 'ok' &&
      flagsCheck?.evidence === plainFlagsCheck?.evidence &&
      !RETIRED_ENVS.some(env => settingsCertWords.includes(env)),
    JSON.stringify({ errors: envSettings.errors, settingsCheck, flagsCheck }),
  )

  const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
  const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
  const { loadTranscriptFile, transcriptLoadDegradation, _resetTranscriptLoadDegradationForTesting } = await import('../../src/utils/sessionStorage/loading.ts')
  const { restoreSessionStateFromLog } = await import('../../src/utils/sessionRestore.ts')
  const sessionFile = join(proofHome, 'retired-posture-session.jsonl')
  let ord = 0
  const ctx = {
    sessionId: '00000000-0000-4000-8000-000000000099' as never,
    nextOrdinal: () => ordinalOf(++ord),
    observedAt: '2026-10-18T00:00:00.000Z',
    source: { channel: 'interactive' as const },
  }
  const assistantRecord = entryToRecord(
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000001',
      parentUuid: null,
      sessionId: '00000000-0000-4000-8000-000000000099',
      timestamp: '2026-10-18T00:00:00.000Z',
      posture: 'quality',
      MERCURY_ROUTER_POSTURE: 'quality',
      MERCURY_MISSION_POLICY: 'specialist-sol',
      message: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-fable-5-1',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } as never,
    ctx,
  )
  const retiredEntryRecord = entryToRecord(
    {
      type: 'route-plan',
      sessionId: '00000000-0000-4000-8000-000000000099',
      posture: 'quality',
      MERCURY_ROUTER: '0',
    } as never,
    ctx,
  )
  writeFileSync(sessionFile, `${JSON.stringify(assistantRecord)}\n${JSON.stringify(retiredEntryRecord)}\n`)
  _resetTranscriptLoadDegradationForTesting()
  const loaded = await loadTranscriptFile(sessionFile)
  const deg = transcriptLoadDegradation()
  await restoreSessionStateFromLog({ messages: [...loaded.messages.values()] as never, sessionId: '00000000-0000-4000-8000-000000000099' }, () => {})
  rmSync(sessionFile, { force: true })
  check(
    'a session file carrying a posture or retired flag in its records loads and restores cleanly without degradation or a refusal sentence',
    loaded.messages.size === 1 && deg === null,
    JSON.stringify({ size: loaded.messages.size, deg }),
  )
}

console.log(`\nkey-entry-one-home: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
