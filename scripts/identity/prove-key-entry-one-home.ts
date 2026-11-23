#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
const RETIRED_ENVS = ['MERCURY_ROUTER', 'MERCURY_ROUTER_POSTURE', 'MERCURY_ROUTER_STATE_DIR', 'MERCURY_MISSION_POLICY', 'MERCURY_HELM_CONSOLE', 'MERCURY_CONSOLE_MODEL', 'MERCURY_CHANNELS', 'MERCURY_CHANNEL_ROOM', 'MERCURY_LOCAL_CHANNELS']
const RETIRED_POSTURES = ['adaptive', 'quality', 'balanced', 'fast', 'fixed']
const POSTURE_FILENAME = `${'posture'}.json`

console.log('entering a provider key has one home: /logins')

{
  console.log('\nthe flags and route-store retirement')
  const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.ts')
  for (const env of RETIRED_ENVS) {
    check(`the flag registry carries no row for ${env}`, !FLAG_REGISTRY.some(row => row.env === env), 'remove the retired flag row from FLAG_REGISTRY')
  }
  const homeStores = await import('../../src/platform/storage/projectHomeStores.ts')
  check('the project home stores carry no route-state store (a folder left on disk is never read)', !homeStores.PROJECT_HOME_STORES.some(segments => segments.join('/') === 'router'), 'remove the router store from PROJECT_HOME_STORES in src/platform/storage/projectHomeStores.ts')
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
    const { getProjectDir } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
    const homeRouterDir = join(getProjectDir(storeRepo), 'router')
    const leftovers = homeStores.projectHomeLeftovers(storeRepo)
    const prevHealthDir = process.env.MERCURY_HEALTH_STATE_DIR
    process.env.MERCURY_HEALTH_STATE_DIR = storeRepo
    const { projectEstateCheck } = await import('../../src/platform/health/healthReport.ts')
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
  const { reconnectDoorFor } = await import('../../src/models/roads/credentialWall.ts')
  check('the custom endpoint and the local server name their key variable (no sign-in leg exists for them)', reconnectDoorFor('openai-compat') === 'MERCURY_COMPAT_API_KEY' && reconnectDoorFor('local') === 'MERCURY_LOCAL_API_KEY', 'fix reconnectDoorFor in src/models/roads/credentialWall.ts so openai-compat answers MERCURY_COMPAT_API_KEY and local answers MERCURY_LOCAL_API_KEY')
  const search = await import('../../src/tools/engines/web-search/searchContract.ts')
  check('the web-search key door names the two variables', search.KEYED_DOOR_COMMANDS === 'BRAVE_API_KEY · TAVILY_API_KEY', 'set KEYED_DOOR_COMMANDS in src/tools/engines/web-search/searchContract.ts to BRAVE_API_KEY · TAVILY_API_KEY')
}

{
  console.log('\nthe move: stored-key byte survival, adapters without posture, and request-bytes control')
  const movedSecretsPath = join(REPO, 'src/models/sign-in/account-ledger/providerSecrets.ts')
  const movedRegistryPath = join(REPO, 'src/models/roads/modelRegistry.ts')
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
    const { resolveCompatApiKey } = await import('../../src/models/roads/openaicompat/compatAccounts.ts')
    const { resolveLocalApiKey } = await import('../../src/models/roads/local/localAccounts.ts')
    const { resolveBraveSearchApiKey } = await import('../../src/tools/engines/web-search/brave.ts')
    const { resolveTavilyApiKey } = await import('../../src/tools/engines/web-search/tavily.ts')
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
    check('a key written in the base store format for every key-leg family and all four env-road FORK lanes is read byte for byte with sha256 unchanged', allMatch && shaBefore === shaAfter && (statSync(secretsFile).mode & 0o777) === 0o600, 'fix the stored-key readers in src/models/sign-in/account-ledger/providerSecrets.ts (or the resolve*ApiKey readers under src/models/roads and src/tools/engines/web-search) so every seeded key reads back unchanged and the file is never rewritten')
    rmSync(secretsFile, { force: true })

    const registry = await import(movedRegistryPath)
    const anthropicAdapter = await import('../../src/models/roads/anthropic/anthropicAdapter.ts')
    const zaiAdapter = await import('../../src/models/roads/zai/zaiAdapter.ts')
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
  const { configureEffortParams } = await import('../../src/models/roads/anthropic/requestParams.ts')
  const { buildOpenaiResponsesRequest } = await import('../../src/models/roads/openai/responsesBridge.ts')
  const { buildZaiChatRequest } = await import('../../src/models/roads/zai/zaiCodec.ts')
  const { buildMistralExtras } = await import('../../src/models/roads/mistral/mistralCallModel.ts')
  const { buildMetaExtras } = await import('../../src/models/roads/meta/metaCallModel.ts')
  const { nousLaneProfile } = await import('../../src/models/roads/nous/nousCallModel.ts')
  const { buildZenExtras } = await import('../../src/models/roads/zen/zenCallModel.ts')
  const { buildMoonshotExtras, buildDeepseekExtras, buildOpenrouterExtras, buildXaiExtras, buildCompatSlotExtras, buildHuggingfaceExtras, buildGeminiExtras, buildLocalExtras } = await import('../../src/models/roads/openaicompat/compatWire.ts')
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
  const { composeMissionView, buildMissionRow } = await import('../../src/sessions/mission/projection.ts')
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
}

{
  console.log('\nthe health certificate and the refusal law across environment, settings and session files')
  const report = await import('../../src/platform/health/healthReport.ts')
  const sectionIds = (cert: Awaited<ReturnType<typeof report.runHealthReport>>): string[] => cert.sections.map(s => s.id)
  const plain = await report.runHealthReport({ depth: 'fast' })
  check('no section of the certificate is the route section', !sectionIds(plain).includes('router-fast') && !plain.sections.some(s => s.title === 'ROUTER'), 'remove the router section from runHealthReport in src/platform/health/healthReport.ts')
  check('no check id begins with the retired word', !plain.sections.flatMap(s => s.checks).some(c => c.id.startsWith('router-')), 'rename or remove the router- check in the health sections run by runHealthReport in src/platform/health/healthReport.ts')
  const slots = plain.sections.flatMap(s => s.checks).find(c => c.id === 'provider-slots')
  check('the provider honesty row lives on under AUTH', slots !== undefined && plain.sections.find(s => s.id === 'auth')?.checks.some(c => c.id === 'provider-slots') === true, 'restore the provider-slots check under the auth section built by runHealthReport in src/platform/health/healthReport.ts')
  for (const env of RETIRED_ENVS) process.env[env] = env === 'MERCURY_ROUTER_POSTURE' ? RETIRED_POSTURES[1]! : env === 'MERCURY_MISSION_POLICY' ? 'specialist-sol' : '0'
  const pinned = await report.runHealthReport({ depth: 'fast' })
  for (const env of RETIRED_ENVS) delete process.env[env]
  check('a retired flag set in the environment is an unknown input: the certificate keeps its sections', sectionIds(pinned).join('|') === sectionIds(plain).join('|'), sectionIds(pinned).join('|'))
  const words = pinned.sections.flatMap(s => s.checks).map(c => `${c.evidence ?? ''} ${c.fix ?? ''}`).join('\n')
  check('…and no row answers it with a refusal sentence or names it', !RETIRED_ENVS.some(env => words.includes(env)), 'drop every row that names a retired flag from the health sections run by runHealthReport in src/platform/health/healthReport.ts')

  const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.ts')
  const { getSettingsWithAllErrors } = await import('../../src/platform/settings-faults/allErrors.ts')
  const { applyConfigEnvironmentVariables } = await import('../../src/platform/environment/settingsEnv.ts')
  writeFileSync(
    join(proofHome, 'settings.json'),
    JSON.stringify({
      environment: {
        values: {
          MERCURY_ROUTER: '0',
          MERCURY_ROUTER_POSTURE: RETIRED_POSTURES[1],
          MERCURY_ROUTER_STATE_DIR: '/tmp/retired-router',
          MERCURY_MISSION_POLICY: 'specialist-sol',
          MERCURY_HELM_CONSOLE: '0',
          MERCURY_CONSOLE_MODEL: 'claude-opus-4-8',
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

  const { entryToRecord } = await import('../../src/sessions/fabric/entryCodec.ts')
  const { ordinalOf } = await import('../../src/sessions/fabric/ordinal.ts')
  const { loadTranscriptFile, transcriptLoadDegradation, _resetTranscriptLoadDegradationForTesting } = await import('../../src/sessions/transcripts/loading.ts')
  const { restoreSessionStateFromLog } = await import('../../src/sessions/resume/sessionRestore.ts')
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
