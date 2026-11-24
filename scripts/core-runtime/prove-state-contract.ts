#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'test'
const hermeticHome = mkdtempSync(join(tmpdir(), 't17-state-home-'))
process.env.MERCURY_CONFIG_DIR = join(hermeticHome, 'config')
process.env.MERCURY_DAEMON_DIR = join(hermeticHome, 'daemon')
delete process.env.MERCURY_ASSISTANT_DISABLE

import * as state from '../../src/boot/process-state/processState.js'
import {
  getSessionSettingsCache,
  setSessionSettingsCache,
} from '../../src/platform/settings/settingsCache.js'
import type { SessionId } from '../../src/sessions/transcripts/ids.js'
import type { ModelUsage } from '../../src/boot/process-state/processState.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const statePath = join(repoRoot, 'src', 'boot', 'process-state', 'processState.ts')
const scratch = mkdtempSync(join(tmpdir(), 't17-state-net-'))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`    where: ${new Error().stack?.split('\n')[2]?.trim() ?? 'this file'}; change the state function this check calls in src/boot/process-state/processState.ts so the condition holds`)
  }
}
function section(name: string): void {
  console.log(`── ${name}`)
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const realDateNow = Date.now.bind(Date)
function withClock<T>(t: () => number, body: () => T): T {
  Date.now = t
  try {
    return body()
  } finally {
    Date.now = realDateNow
  }
}

type Scope = 'process' | 'session' | 'conversation' | 'turn' | 'derived'
function ser(v: unknown): string {
  if (v instanceof Map) {
    return (
      'Map:' +
      JSON.stringify([...v.entries()].map(([k, val]) => [k, serPlain(val)]))
    )
  }
  if (v instanceof Set) return 'Set:' + JSON.stringify([...v.values()])
  return serPlain(v)
}
function serPlain(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (typeof v === 'function') return 'fn'
  if (v !== null && typeof v === 'object') {
    try {
      return JSON.stringify(v) ?? 'object'
    } catch {
      return 'object'
    }
  }
  return JSON.stringify(v) ?? String(v)
}
const OBSERVABLES: Array<{
  key: string
  family: string
  scope: Scope
  read: () => unknown
}> = [
  { key: 'sessionId', family: 'identity', scope: 'conversation', read: () => state.getSessionId() },
  { key: 'sessionProjectDir', family: 'identity', scope: 'conversation', read: () => state.getSessionProjectDir() },
  { key: 'planSlugCache', family: 'identity', scope: 'session', read: () => state.getPlanSlugCache() },
  { key: 'originalCwd', family: 'cwd', scope: 'process', read: () => state.getOriginalCwd() },
  { key: 'projectRoot', family: 'cwd', scope: 'process', read: () => state.getProjectRoot() },
  { key: 'cwdState', family: 'cwd', scope: 'process', read: () => state.getCwdState() },
  { key: 'totalCostUSD', family: 'cost', scope: 'conversation', read: () => state.getTotalCostUSD() },
  { key: 'totalAPIDuration', family: 'cost', scope: 'conversation', read: () => state.getTotalAPIDuration() },
  { key: 'totalAPIDurationWithoutRetries', family: 'cost', scope: 'conversation', read: () => state.getTotalAPIDurationWithoutRetries() },
  { key: 'totalToolDuration', family: 'cost', scope: 'conversation', read: () => state.getTotalToolDuration() },
  { key: 'totalLinesAdded', family: 'cost', scope: 'conversation', read: () => state.getTotalLinesAdded() },
  { key: 'totalLinesRemoved', family: 'cost', scope: 'conversation', read: () => state.getTotalLinesRemoved() },
  { key: 'hasUnknownModelCost', family: 'cost', scope: 'conversation', read: () => state.hasUnknownModelCost() },
  { key: 'modelUsage', family: 'cost', scope: 'conversation', read: () => state.getModelUsage() },
  { key: 'unpricedTurns', family: 'cost', scope: 'conversation', read: () => state.getUnpricedTurns() },
  { key: 'totalInputTokens', family: 'cost', scope: 'derived', read: () => state.getTotalInputTokens() },
  { key: 'totalOutputTokens', family: 'cost', scope: 'derived', read: () => state.getTotalOutputTokens() },
  { key: 'totalCacheReadInputTokens', family: 'cost', scope: 'derived', read: () => state.getTotalCacheReadInputTokens() },
  { key: 'totalCacheCreationInputTokens', family: 'cost', scope: 'derived', read: () => state.getTotalCacheCreationInputTokens() },
  { key: 'totalWebSearchRequests', family: 'cost', scope: 'derived', read: () => state.getTotalWebSearchRequests() },
  { key: 'lastInteractionTime', family: 'interaction', scope: 'process', read: () => state.getLastInteractionTime() },
  { key: 'engineModelOverride', family: 'model', scope: 'session', read: () => state.getEngineModelOverride() },
  { key: 'modelStrings', family: 'model', scope: 'session', read: () => (state.getModelStrings() === null ? null : 'set') },
  { key: 'sdkBetas', family: 'model', scope: 'session', read: () => state.getSdkBetas() },
  { key: 'statsStore', family: 'telemetry', scope: 'process', read: () => (state.getStatsStore() === null ? null : 'set') },
  { key: 'lastAPIRequest', family: 'apiCapture', scope: 'conversation', read: () => state.getLastAPIRequest() },
  { key: 'promptId', family: 'apiCapture', scope: 'conversation', read: () => state.getPromptId() },
  { key: 'lastMainRequestId', family: 'apiCapture', scope: 'conversation', read: () => state.getLastMainRequestId() },
  { key: 'lastApiCompletionTimestamp', family: 'apiCapture', scope: 'conversation', read: () => state.getLastApiCompletionTimestamp() },
  { key: 'promptCache1hEligible', family: 'latches', scope: 'session', read: () => state.getPromptCache1hEligible() },
  { key: 'systemPromptSectionCache', family: 'caches', scope: 'session', read: () => state.getSystemPromptSectionCache() },
  { key: 'isInteractive', family: 'posture', scope: 'session', read: () => state.getIsInteractive() },
  { key: 'isNonInteractive', family: 'posture', scope: 'derived', read: () => state.getIsNonInteractiveSession() },
  { key: 'sessionKind', family: 'posture', scope: 'session', read: () => state.getSessionKind() },
  { key: 'preferThirdPartyAuth', family: 'posture', scope: 'derived', read: () => state.preferThirdPartyAuthentication() },
  { key: 'assistantSessionActive', family: 'posture', scope: 'session', read: () => state.isAssistantSessionActive() },
  { key: 'assistantAvailable', family: 'posture', scope: 'derived', read: () => state.isAssistantFamilyAvailable() },
  { key: 'strictToolResultPairing', family: 'posture', scope: 'session', read: () => state.getStrictToolResultPairing() },
  { key: 'questionPreviewFormat', family: 'posture', scope: 'session', read: () => state.getQuestionPreviewFormat() },
  { key: 'isRemoteMode', family: 'posture', scope: 'session', read: () => state.getIsRemoteMode() },
  { key: 'sessionBypassPermissionsMode', family: 'posture', scope: 'session', read: () => state.getSessionSovereign() },
  { key: 'permissionModeResolution', family: 'posture', scope: 'session', read: () => state.getSessionPermissionModeResolution() },
  { key: 'sessionTrustAccepted', family: 'posture', scope: 'session', read: () => state.getSessionTrustAccepted() },
  { key: 'sessionPersistenceDisabled', family: 'posture', scope: 'session', read: () => state.isSessionPersistenceDisabled() },
  { key: 'flagSettingsPath', family: 'boot', scope: 'process', read: () => state.getFlagSettingsPath() },
  { key: 'flagSettingsInline', family: 'boot', scope: 'process', read: () => state.getFlagSettingsInline() },
  { key: 'allowedSettingSources', family: 'boot', scope: 'process', read: () => state.getAllowedSettingSources() },
  { key: 'sessionExtensions', family: 'boot', scope: 'process', read: () => state.getSessionExtensions() },
  { key: 'mainThreadAgentType', family: 'boot', scope: 'process', read: () => state.getMainThreadAgentType() },
  { key: 'registeredHooks', family: 'hookRegistry', scope: 'session', read: () => state.getRegisteredHooks() },
  { key: 'invokedSkills', family: 'collections', scope: 'session', read: () => state.getInvokedSkillsForAgent(null) },
]

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const o of OBSERVABLES) out[o.key] = ser(o.read())
  return out
}
function deltaKeys(a: Record<string, string>, b: Record<string, string>): string[] {
  return Object.keys(a)
    .filter(k => a[k] !== b[k])
    .sort()
}
function expectDelta(
  label: string,
  before: Record<string, string>,
  after: Record<string, string>,
  expected: string[],
): void {
  const got = deltaKeys(before, after)
  const want = [...expected].sort()
  const unexpected = got.filter(k => !want.includes(k))
  const missing = want.filter(k => !got.includes(k))
  check(
    label,
    unexpected.length === 0 && missing.length === 0,
    `unexpected=[${unexpected.join(',')}] missing=[${missing.join(',')}]`,
  )
}

function usage(k: number): ModelUsage {
  return {
    inputTokens: k,
    outputTokens: k * 2,
    cacheReadInputTokens: k * 3,
    cacheCreationInputTokens: k * 4,
    webSearchRequests: k,
    costUSD: 0.1,
    contextWindow: 200000,
    maxOutputTokens: 8192,
  } as ModelUsage
}
let childN = 0
const childDir = join(scratch, 'children')
mkdirSync(childDir, { recursive: true })
function runChild(
  source: string,
  opts: { env?: Record<string, string>; cwd?: string } = {},
): { json: Record<string, unknown> | null; raw: string; err: string } {
  const p = join(childDir, `child-${childN++}.ts`)
  writeFileSync(p, source)
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.MERCURY_ASSISTANT_DISABLE
  Object.assign(env, opts.env ?? {})
  const child = Bun.spawnSync({
    cmd: [process.execPath, 'run', p],
    env: env as never,
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const raw = child.stdout.toString().trim()
  const last = raw.split('\n').filter(Boolean).pop() ?? ''
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(last) as Record<string, unknown>
  } catch {
    json = null
  }
  return { json, raw, err: child.stderr.toString() }
}
const stateAbs = statePath

console.log('native-core T17 — runtime state owner contract')

check('setup: assistant default latches ON under a clean env', state.isAssistantFamilyAvailable() === true)
check('setup: no explicit session flip at boot', state.isAssistantSessionActive() === false)

const bootSnapshot = snapshot()
const bootSessionId = state.getSessionId()
check('setup: boot sessionId is uuid-shaped', UUID_RE.test(bootSessionId), bootSessionId)
check(
  'setup: boot cwd trio agrees (originalCwd===projectRoot===cwd)',
  state.getOriginalCwd() === state.getProjectRoot() &&
    state.getProjectRoot() === state.getCwdState(),
)

section('LAW EXPORT-SURFACE — the frozen facade lock')
{
  const EXPECTED_VALUE_EXPORTS = [
    'addInvokedSkill', 'addToToolDuration',
    'canAnswerAsks', 'getAskChannel', 'setAskChannel',
    'getSessionKind', 'setSessionKind',
    'addToTotalCostState', 'addToTotalDurationState', 'addToTotalLinesChanged',
    'addToWorkloadUsageState', 'getWorkloadUnpricedTurns', 'getWorkloadUsage', 'recordWorkloadUnpricedTurn',
    'canAnswerAsks',
    'clearInvokedSkillsForAgent', 'clearRegisteredHooks',
    'clearRegisteredExtensionHooks', 'clearSystemPromptSectionState',
    'flushInteractionTime',
    'getAskChannel',
    'getAllowedSettingSources',
    'getCwdState', 'getFlagSettingsInline', 'getFlagSettingsPath',
    'getSessionExtensions',
    'getInvokedSkillsForAgent', 'getIsInteractive',
    'getIsNonInteractiveSession', 'getIsRemoteMode', 'getIsScrollDraining', 'getIsSessionOneShotHeadless', 'isAssistantFamilyAvailable', 'isRunInputClosed', 'setRunInputClosed',
    'isAssistantSessionActive', 'getLastAPIRequest',
    'getLastApiCompletionTimestamp',
    'getLastInteractionTime', 'getLastMainRequestId', 'getEngineModelOverride', 'getMainThreadAgentType', 'getModelStrings', 'getModelUsage', 'getOriginalCwd',
    'getPlanSlugCache', 'getProjectRoot',
    'getPromptCache1hEligible', 'getPromptId',
    'getQuestionPreviewFormat', 'getRegisteredHooks',
    'getSdkBetas', 'getSessionSovereign',
    'getSessionId',
    'getSessionProjectDir',
    'getSessionTrustAccepted', 'getStatsStore', 'getSessionPermissionModeResolution',
    'getStrictToolResultPairing', 'getSystemPromptSectionCache',
    'getTotalAPIDuration',
    'getTotalAPIDurationWithoutRetries', 'getTotalCacheCreationInputTokens',
    'getTotalCacheReadInputTokens', 'getTotalCostUSD', 'getTotalDuration',
    'getTotalInputTokens', 'getTotalLinesAdded', 'getTotalLinesRemoved',
    'getTotalOutputTokens', 'getTotalToolDuration', 'getTotalUnpricedTurns', 'getTotalWebSearchRequests',
    'getUnpricedTurns', 'getUsageForModel',
    'hasUnknownModelCost',
    'isSessionPersistenceDisabled',
    'markScrollActivity',
    'onSessionSwitch',
    'preferThirdPartyAuthentication', 'recordUnpricedTurn', 'regenerateSessionId', 'registerHookCallbacks',
    'resetCostState',
    'resetStateForTests',
    'setAllowedSettingSources',
    'setAskChannel',
    'setClientType', 'setCostStateForRestore', 'setCwdState',
    'setFlagSettingsInline', 'setFlagSettingsPath',
    'setHasUnknownModelCost', 'setHeadlessOneShot',
    'setSessionExtensions', 'setIsInteractive',
    'setAssistantSessionActive', 'setLastAPIRequest',
    'setLastApiCompletionTimestamp',
    'setLastMainRequestId',
    'setEngineModelOverride', 'setMainThreadAgentType', 'setModelStrings',
    'setOriginalCwd', 'setProjectRoot',
    'setPromptCache1hEligible', 'setQuestionPreviewFormat',
    'setSdkBetas',
    'setSessionSovereign', 'setSessionPermissionModeResolution',
    'setSessionPersistenceDisabled', 'setSessionTrustAccepted',
    'setStatsStore', 'setStrictToolResultPairing', 'setSystemPromptSectionCacheEntry',
    'subscribeCwdState', 'subscribeEngineModelOverride', 'switchSession',
    'updateLastInteractionTime', 'waitForScrollIdle',
  ]
  const actual = Object.keys(state).sort()
  const missing = EXPECTED_VALUE_EXPORTS.filter(k => !actual.includes(k))
  const extra = actual.filter(k => !EXPECTED_VALUE_EXPORTS.includes(k))
  check(
    `export census: exactly ${EXPECTED_VALUE_EXPORTS.length} value exports, names locked`,
    missing.length === 0 && extra.length === 0,
    `missing=[${missing.join(',')}] extra=[${extra.join(',')}]`,
  )
}


section('LAW 12 SLOW-OPS-ABSENT — the dormant family is DELETED')
{
  const exports = state as never as Record<string, unknown>
  check('absence: addSlowOperation is gone from the facade', !('addSlowOperation' in exports))
  check('absence: getSlowOperations is gone from the facade', !('getSlowOperations' in exports))
}

section('LAW ONE ROOT — no added-directory state or readers')
{
  const exports = state as never as Record<string, unknown>
  check('one root: the facade has no added-directory accessors', exports.getAddedDirectories === undefined && exports.setAddedDirectories === undefined)
  const stem = ['Claude', 'Md'].join('')
  check(
    "one owner: no facade export names the other product's instruction file",
    !Object.keys(exports).some(k => k.includes(stem)),
    Object.keys(exports).filter(k => k.includes(stem)).join(','),
  )
}

section('LAW 1 SESSION-SWITCH — atomic pair · never-carries · signal law')
{
  const s0 = state.getSessionId()
  let emissions = 0
  let lastArg: string | null = null
  let insideRead: string | null = null
  const unsub = state.onSessionSwitch(id => {
    emissions++
    lastArg = id
    insideRead = state.getSessionId()
  })
  const S1 = '11111111-1111-4111-8111-111111111111' as SessionId
  const S2 = '22222222-2222-4222-8222-222222222222' as SessionId
  state.getPlanSlugCache().set(s0, 'slug-of-s0')
  state.getPlanSlugCache().set('bystander', 'slug-bystander')

  state.switchSession(S1, '/tmp/t17-project-a')
  check('switch: sessionId updated', state.getSessionId() === S1)
  check('switch: projectDir updated atomically', state.getSessionProjectDir() === '/tmp/t17-project-a')
  check('switch: signal fired exactly once', emissions === 1, String(emissions))
  check('switch: signal payload is the new id', lastArg === S1)
  check('switch: subscriber reads the NEW id synchronously (emit-after-write)', insideRead === S1)
  check('switch: outgoing planSlugCache entry evicted', !state.getPlanSlugCache().has(s0))
  check('switch: bystander planSlugCache entry survives', state.getPlanSlugCache().get('bystander') === 'slug-bystander')

  state.switchSession(S2)
  check('switch: projectDir NEVER carries over (omitted ⇒ null)', state.getSessionProjectDir() === null)
  check('switch: second emission', emissions === 2)

  state.switchSession(S2)
  check('switch: same-id switch still emits (characterized — no guard)', emissions === 3)

  let reentered = false
  const unsub2 = state.onSessionSwitch(() => {
    if (!reentered) {
      reentered = true
      state.switchSession(S1, '/tmp/t17-nested')
    }
  })
  state.switchSession(S2)
  check('switch: reentrant subscriber switch lands (nested id wins)', state.getSessionId() === S1)
  check('switch: nested emission observed by the first subscriber', lastArg === S1)
  unsub2()

  state.switchSession(S2, '/tmp/t17-project-b')
  state.getPlanSlugCache().set(S2, 'slug-of-s2')
  const emissionsBeforeRegen = emissions
  const regenerated = state.regenerateSessionId()
  check('regenerate: does NOT emit the switch signal (characterized)', emissions === emissionsBeforeRegen)
  check('regenerate: returns the live sessionId', regenerated === state.getSessionId())
  check('regenerate: fresh id is uuid-shaped', UUID_RE.test(regenerated), regenerated)
  check('regenerate: fresh id differs', regenerated !== S2)
  check('regenerate: projectDir reset to null', state.getSessionProjectDir() === null)
  check('regenerate: outgoing slug evicted', !state.getPlanSlugCache().has(S2))

  unsub()
  const emissionsAtUnsub = emissions
  state.switchSession(S1)
  check('unsubscribe works (no further emissions)', emissions === emissionsAtUnsub)
  state.getPlanSlugCache().delete('bystander')
}

section('LAW 14 CWD-NFC — normalization on every setter + the boot leg')
{
  const bootOriginal = state.getOriginalCwd()
  const bootRoot = state.getProjectRoot()
  const bootCwd = state.getCwdState()
  const NFD = '/tmp/t17-cafe\u0301-dir'
  const NFC = '/tmp/t17-caf\u00e9-dir'
  check('fixture sanity: NFD and NFC spellings differ', NFD !== NFC && NFD.normalize('NFC') === NFC)
  state.setOriginalCwd(NFD)
  check('setOriginalCwd normalizes NFD ⇒ NFC', state.getOriginalCwd() === NFC)
  state.setProjectRoot(NFD)
  check('setProjectRoot normalizes NFD ⇒ NFC', state.getProjectRoot() === NFC)
  state.setCwdState(NFD)
  check('setCwdState normalizes NFD ⇒ NFC', state.getCwdState() === NFC)
  state.setOriginalCwd(NFC)
  check('setOriginalCwd is NFC-idempotent', state.getOriginalCwd() === NFC)
  state.setOriginalCwd(bootOriginal)
  state.setProjectRoot(bootRoot)
  state.setCwdState(bootCwd)

  const realDir = join(scratch, 'boot-cafe\u0301-real')
  const symDir = join(scratch, 'boot-sym')
  mkdirSync(realDir, { recursive: true })
  symlinkSync(realDir, symDir)
  const expected = realpathSync(symDir).normalize('NFC')
  const boot = runChild(
    `import * as s from ${JSON.stringify(stateAbs)}\n` +
      `console.log(JSON.stringify({ o: s.getOriginalCwd(), p: s.getProjectRoot(), c: s.getCwdState(), id: s.getSessionId() }))\n`,
    { cwd: symDir },
  )
  check('boot leg: child produced JSON', boot.json !== null, boot.err.slice(0, 200))
  if (boot.json) {
    check('boot leg: originalCwd is the physical NFC path', boot.json.o === expected, `${String(boot.json.o)} vs ${expected}`)
    check('boot leg: originalCwd is NFC-normalized form', String(boot.json.o).normalize('NFC') === boot.json.o)
    check('boot leg: trio agrees at boot', boot.json.o === boot.json.p && boot.json.p === boot.json.c)
    check('boot leg: boot sessionId uuid-shaped', UUID_RE.test(String(boot.json.id)))
  }
}

section('LAW 14b CWD-BEAT — subscribeCwdState fires on every setCwdState write')
{
  const bootCwd = state.getCwdState()
  const NFD = '/tmp/t17-beat-cafe\u0301'
  const NFC = '/tmp/t17-beat-caf\u00e9'
  check('cwd-beat fixture sanity: NFD and NFC spellings differ', NFD !== NFC && NFD.normalize('NFC') === NFC)
  let beats = 0
  let heardArg = ''
  let insideRead = ''
  const unsub = state.subscribeCwdState(cwd => {
    beats++
    heardArg = cwd
    insideRead = state.getCwdState()
  })
  state.setCwdState(NFD)
  check('cwd-beat: emit-after-write (subscriber reads the NEW cwd synchronously)', insideRead === NFC, insideRead)
  check('cwd-beat: the emitted argument is the normalized stored value', heardArg === NFC, heardArg)
  state.setCwdState(NFD)
  check('cwd-beat: a same-value write re-emits (no guard in the owner)', beats === 2, String(beats))
  unsub()
  state.setCwdState(bootCwd)
  check('cwd-beat: unsubscribe works (no further emissions)', beats === 2, String(beats))
}

section('LAW 2 COST-LEDGER — accumulate vs REPLACE · restore math')
{
  const T0 = 1_700_000_000_000
  withClock(() => T0, () => {
    state.resetCostState()
    check('clean slate: totalCostUSD 0', state.getTotalCostUSD() === 0)
    check('clean slate: getTotalDuration 0 under a frozen clock', state.getTotalDuration() === 0)

    const A = usage(10)
    const B = usage(3)
    state.addToTotalCostState(0.5, A, 'model-x')
    check('cost accumulates (first add)', state.getTotalCostUSD() === 0.5)
    check('modelUsage stores the payload by REFERENCE', state.getUsageForModel('model-x') === A)
    state.addToTotalCostState(0.25, B, 'model-x')
    check('cost ACCUMULATES across adds', state.getTotalCostUSD() === 0.75)
    check(
      'modelUsage REPLACES the per-model entry (the rewrite trap)',
      state.getUsageForModel('model-x') === B,
    )
    const C = usage(7)
    state.addToTotalCostState(0.1, C, 'model-y')
    check('token sums span models: input', state.getTotalInputTokens() === 3 + 7)
    check('token sums span models: output', state.getTotalOutputTokens() === 6 + 14)
    check('token sums span models: cacheRead', state.getTotalCacheReadInputTokens() === 9 + 21)
    check('token sums span models: cacheCreation', state.getTotalCacheCreationInputTokens() === 12 + 28)
    check('token sums span models: webSearch', state.getTotalWebSearchRequests() === 3 + 7)

    check('hasUnknownModelCost starts false', state.hasUnknownModelCost() === false)
    state.setHasUnknownModelCost()
    check('setHasUnknownModelCost latches true', state.hasUnknownModelCost() === true)

    state.addToTotalDurationState(100, 80)
    state.addToTotalDurationState(50, 40)
    check('API duration accumulates', state.getTotalAPIDuration() === 150)
    check('API duration w/o retries accumulates', state.getTotalAPIDurationWithoutRetries() === 120)
    state.addToTotalLinesChanged(3, 1)
    state.addToTotalLinesChanged(2, 2)
    check('lines added accumulate', state.getTotalLinesAdded() === 5)
    check('lines removed accumulate', state.getTotalLinesRemoved() === 3)
  })

  const T1 = 1_700_000_500_000
  withClock(() => T1, () => {
    const D = usage(11)
    state.setCostStateForRestore({
      totalCostUSD: 9.5,
      totalAPIDuration: 111,
      totalAPIDurationWithoutRetries: 101,
      totalToolDuration: 55,
      totalLinesAdded: 8,
      totalLinesRemoved: 4,
      lastDuration: 5000,
      modelUsage: { 'model-restored': D },
    })
    check('restore: totalCostUSD echoed', state.getTotalCostUSD() === 9.5)
    check('restore: durations echoed', state.getTotalAPIDuration() === 111 && state.getTotalAPIDurationWithoutRetries() === 101)
    check('restore: tool duration echoed', state.getTotalToolDuration() === 55)
    check('restore: lines echoed', state.getTotalLinesAdded() === 8 && state.getTotalLinesRemoved() === 4)
    check(
      'restore: startTime = now − lastDuration ⇒ wall duration resumes EXACTLY',
      state.getTotalDuration() === 5000,
      String(state.getTotalDuration()),
    )
    check('restore: modelUsage wholesale-replaced', state.getUsageForModel('model-x') === undefined && state.getUsageForModel('model-restored') === D)

    state.setCostStateForRestore({
      totalCostUSD: 1,
      totalAPIDuration: 1,
      totalAPIDurationWithoutRetries: 1,
      totalToolDuration: 1,
      totalLinesAdded: 1,
      totalLinesRemoved: 1,
      lastDuration: undefined,
      modelUsage: undefined,
    })
    check('restore: lastDuration undefined leaves startTime alone', state.getTotalDuration() === 5000)
    check('restore: modelUsage undefined preserves the breakdown', state.getUsageForModel('model-restored') === D)

    state.resetCostState()
    check('resetCostState: cost zeroed', state.getTotalCostUSD() === 0)
    check('resetCostState: durations zeroed', state.getTotalAPIDuration() === 0 && state.getTotalAPIDurationWithoutRetries() === 0 && state.getTotalToolDuration() === 0)
    check('resetCostState: lines zeroed', state.getTotalLinesAdded() === 0 && state.getTotalLinesRemoved() === 0)
    check('resetCostState: unknown-cost flag cleared', state.hasUnknownModelCost() === false)
    check('resetCostState: modelUsage emptied', Object.keys(state.getModelUsage()).length === 0)
    check('resetCostState: promptId nulled', state.getPromptId() === null)
    check('resetCostState: startTime re-stamped (duration 0)', state.getTotalDuration() === 0)
  })
}

section('LAW 3 TOOL-DURATION — the total accumulates')
{
  const totalToolBefore = state.getTotalToolDuration()
  state.addToToolDuration(40)
  check('tool add: TOTAL accumulates in the same call', state.getTotalToolDuration() === totalToolBefore + 40)
}

section('LAW 6 ASSISTANT — the env matrix · flip supremacy · the memo latch')
{
  const ASSISTANT_CHILD =
    `import * as s from ${JSON.stringify(stateAbs)}\n` +
    `if (process.env.T17_FLIP === '1') s.setAssistantSessionActive(true)\n` +
    `console.log(JSON.stringify({ active: s.isAssistantFamilyAvailable(), session: s.isAssistantSessionActive() }))\n`
  type Cell = { env: Record<string, string>; flip: boolean; active: boolean; label: string }
  const cells: Cell[] = [
    { env: {}, flip: false, active: true, label: 'unset' },
    { env: {}, flip: true, active: true, label: 'unset+flip' },
    { env: { MERCURY_ASSISTANT_DISABLE: 'on' }, flip: false, active: false, label: 'MERCURY_ASSISTANT_DISABLE=on' },
    { env: { MERCURY_ASSISTANT_DISABLE: ' TRUE ' }, flip: false, active: false, label: 'MERCURY_ASSISTANT_DISABLE=" TRUE " (trim+case)' },
    { env: { MERCURY_ASSISTANT_DISABLE: 'off' }, flip: false, active: true, label: 'MERCURY_ASSISTANT_DISABLE=off (not truthy)' },
    { env: { MERCURY_ASSISTANT_DISABLE: 'on' }, flip: true, active: true, label: 'MERCURY_ASSISTANT_DISABLE=on+flip (flip supremacy)' },
  ]
  for (const cell of cells) {
    const env = { ...cell.env, ...(cell.flip ? { T17_FLIP: '1' } : {}) }
    const r = runChild(ASSISTANT_CHILD, { env })
    check(`assistant matrix [${cell.label}]: child ran`, r.json !== null, r.err.slice(0, 200))
    if (!r.json) continue
    check(`assistant matrix [${cell.label}]: isAssistantFamilyAvailable=${cell.active}`, r.json.active === cell.active, r.raw)
    check(`assistant matrix [${cell.label}]: isAssistantSessionActive reads ONLY the flip`, r.json.session === cell.flip, r.raw)
  }
  const MEMO_CHILD =
    `import * as s from ${JSON.stringify(stateAbs)}\n` +
    `const first = s.isAssistantFamilyAvailable()\n` +
    `process.env.MERCURY_ASSISTANT_DISABLE = 'on'\n` +
    `console.log(JSON.stringify({ first, second: s.isAssistantFamilyAvailable(), session: s.isAssistantSessionActive() }))\n`
  const memo = runChild(MEMO_CHILD, {})
  check('assistant memo: child ran', memo.json !== null, memo.err.slice(0, 200))
  if (memo.json) {
    check('assistant memo: first read latches ON', memo.json.first === true)
    check('assistant memo: post-read env flip is ignored (first-read latch)', memo.json.second === true)
    check('assistant memo: session flip still false throughout', memo.json.session === false)
  }
  process.env.MERCURY_ASSISTANT_DISABLE = 'on'
  check('assistant memo (in-process): env flip after first read is ignored', state.isAssistantFamilyAvailable() === true)
  delete process.env.MERCURY_ASSISTANT_DISABLE
}

section('LAW 7 INTERACTION-CLOCK — deferred dirty bit · flush-once · immediate')
{
  const T = 1_800_000_000_000
  withClock(() => T, () => {
    state.flushInteractionTime()
  })
  const base = state.getLastInteractionTime()
  withClock(() => T + 1000, () => {
    state.updateLastInteractionTime()
    check('deferred: timestamp does NOT move on update', state.getLastInteractionTime() === base)
    state.flushInteractionTime()
    check('flush: timestamp moves to now', state.getLastInteractionTime() === T + 1000)
  })
  withClock(() => T + 2000, () => {
    state.flushInteractionTime()
    check('flush is once-per-dirty (second flush is a no-op)', state.getLastInteractionTime() === T + 1000)
    state.updateLastInteractionTime(true)
    check('immediate=true moves the timestamp synchronously', state.getLastInteractionTime() === T + 2000)
    state.flushInteractionTime()
    check('immediate consumed the dirty bit (flush after immediate is a no-op)', state.getLastInteractionTime() === T + 2000)
  })
}

section('LAW 8 SCROLL-DRAIN — debounce · unref discipline · idle release')
{
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  type Pending = { cb: () => void; delay: number; unrefd: boolean; cleared: boolean }
  const pending: Pending[] = []
  try {
    const handles = new Map<object, Pending>()
    globalThis.setTimeout = ((cb: () => void, delay?: number) => {
      const p: Pending = { cb, delay: delay ?? 0, unrefd: false, cleared: false }
      pending.push(p)
      const h = {
        unref() {
          p.unrefd = true
          return this
        },
      }
      handles.set(h, p)
      return h as never
    }) as never
    globalThis.clearTimeout = ((h: object) => {
      const p = handles.get(h)
      if (p) p.cleared = true
    }) as never

    check('scroll: not draining before any activity', state.getIsScrollDraining() === false)
    state.markScrollActivity()
    check('scroll: draining immediately after mark', state.getIsScrollDraining() === true)
    check('scroll: one debounce timer armed at 150ms', pending.length === 1 && pending[0]!.delay === 150, JSON.stringify(pending.map(p => p.delay)))
    check('scroll: the debounce timer is unref’d (never holds the process)', pending[0]!.unrefd === true)
    state.markScrollActivity()
    check('scroll: re-mark clears the old timer (extend, not stack)', pending[0]!.cleared === true)
    check('scroll: re-mark arms a fresh 150ms timer', pending.length === 2 && pending[1]!.delay === 150 && !pending[1]!.cleared)
    check('scroll: still draining across the re-mark', state.getIsScrollDraining() === true)
    pending[1]!.cb()
    check('scroll: debounce expiry clears the flag', state.getIsScrollDraining() === false)
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }

  const keepalive = setInterval(() => {}, 50)
  try {
    await state.waitForScrollIdle()
    check('waitForScrollIdle: immediate resolve when not draining', true)
    state.markScrollActivity()
    check('waitForScrollIdle setup: draining after mark', state.getIsScrollDraining() === true)
    const t0 = realDateNow()
    const results = await Promise.all([
      state.waitForScrollIdle().then(() => state.getIsScrollDraining()),
      state.waitForScrollIdle().then(() => state.getIsScrollDraining()),
    ])
    const waited = realDateNow() - t0
    check('waitForScrollIdle: both concurrent waiters released, flag clear', results[0] === false && results[1] === false)
    check('waitForScrollIdle: release took at least one idle window', waited >= 100, `${waited}ms`)
    check('waitForScrollIdle: release within a generous deadline', waited < 5000, `${waited}ms`)
  } finally {
    clearInterval(keepalive)
  }
}

section('LAW 9 HOOK-REGISTRY — merge order · extensionRoot clear · empty ⇒ null')
{
  const cb1 = { tag: 'cb1' }
  const cb2 = { tag: 'cb2' }
  const ext1 = { tag: 'ext1', extensionRoot: '/extensions/one' }
  const extOnly = { tag: 'extOnly', extensionRoot: '/extensions/two' }

  state.clearRegisteredHooks()
  check('registry: starts null after clear', state.getRegisteredHooks() === null)
  state.registerHookCallbacks({ 'tool.before': [cb1] } as never)
  state.registerHookCallbacks({ 'tool.before': [cb2], 'turn.answer': [ext1] } as never)
  const reg = state.getRegisteredHooks() as never as Record<string, Array<{ tag: string }>>
  check('registry: repeated registration MERGES, order preserved', reg['tool.before']?.length === 2 && reg['tool.before'][0] === (cb1 as never) && reg['tool.before'][1] === (cb2 as never))
  check('registry: second event registered', reg['turn.answer']?.length === 1 && reg['turn.answer'][0] === (ext1 as never))

  state.clearRegisteredExtensionHooks()
  check('extension clear: the registry holds extension matchers only, so the clear collapses it to null', state.getRegisteredHooks() === null)

  state.clearRegisteredHooks()
  state.registerHookCallbacks({ 'session.start': [extOnly] } as never)
  state.clearRegisteredExtensionHooks()
  check('extension clear: all-extension registry collapses to null', state.getRegisteredHooks() === null)
  state.clearRegisteredExtensionHooks()
  check('extension clear: idempotent on null', state.getRegisteredHooks() === null)

  state.registerHookCallbacks({ 'tool.before': [cb1] } as never)
  state.clearRegisteredHooks()
  check('clearRegisteredHooks: nulls the registry', state.getRegisteredHooks() === null)
}

section('LAW 10 SKILL-TRACKING — composite keys · filters')
{
  const T = 1_800_000_100_000
  withClock(() => T, () => {
    state.addInvokedSkill('alpha', '/skills/alpha', 'content-main', null)
    state.addInvokedSkill('alpha', '/skills/alpha', 'content-agent1', 'agent1')
    check('skills: composite keys prevent cross-agent overwrite', state.getInvokedSkillsForAgent(null).size + state.getInvokedSkillsForAgent('agent1').size === 2)
    check('skills: main-thread key shape `:name`', state.getInvokedSkillsForAgent(null).get(':alpha')?.content === 'content-main')
    check('skills: agent key shape `agent:name`', state.getInvokedSkillsForAgent('agent1').get('agent1:alpha')?.content === 'content-agent1')

    const forNull = state.getInvokedSkillsForAgent(null)
    check('skills: filter agentId=null returns only main-thread entries', forNull.size === 1 && forNull.has(':alpha'))
    const forUndef = state.getInvokedSkillsForAgent(undefined)
    check('skills: undefined normalizes to null in the filter', forUndef.size === 1 && forUndef.has(':alpha'))
    const forA1 = state.getInvokedSkillsForAgent('agent1')
    check('skills: filter agentId=agent1 exact', forA1.size === 1 && forA1.has('agent1:alpha'))

    state.addInvokedSkill('beta', '/skills/beta', 'c', 'agent2')
    state.clearInvokedSkillsForAgent('agent2')
    check('skills: per-agent clear removes only that agent', state.getInvokedSkillsForAgent('agent2').size === 0 && state.getInvokedSkillsForAgent(null).size === 1 && state.getInvokedSkillsForAgent('agent1').size === 1)
    state.clearInvokedSkillsForAgent('agent1')
  })
}


section('LAW 16 API-CAPTURE — reference semantics (the /share reality pin)')
{
  const req = { model: 'model-req', max_tokens: 1 }
  state.setLastAPIRequest(req as never)
  check('capture: request params stored by reference', state.getLastAPIRequest() === (req as never))

  state.setLastMainRequestId('req_abc123')
  check('capture: lastMainRequestId round-trips', state.getLastMainRequestId() === 'req_abc123')
  state.setLastApiCompletionTimestamp(1_700_000_000_123)
  check('capture: lastApiCompletionTimestamp round-trips', state.getLastApiCompletionTimestamp() === 1_700_000_000_123)
  state.setLastAPIRequest(null)
}

section('LAW 15 MODEL-CONFIG — override/strings/betas round-trips')
{
  state.setEngineModelOverride('claude-opus-4-8' as never)
  check('model: override round-trips', state.getEngineModelOverride() === ('claude-opus-4-8' as never))
  state.setEngineModelOverride(undefined)
  check('model: override accepts undefined (cleared)', state.getEngineModelOverride() === undefined)
  const strings = { fromEnv: 'x' }
  state.setModelStrings(strings as never)
  check('model: modelStrings stored by reference', state.getModelStrings() === (strings as never))
  const betas = ['context-1m-2025-08-07']
  state.setSdkBetas(betas)
  check('model: sdkBetas stored by reference', state.getSdkBetas() === betas)
  state.setSdkBetas(undefined)
  check('model: sdkBetas clearable', state.getSdkBetas() === undefined)
}

section('LAW SCOPE-DELTA — every reset entry point, exact field-by-field')
{
  let populateN = 0
  const cbHook = { tag: 'scope-cb' }
  const extHook = { tag: 'scope-ext', extensionRoot: '/p' }
  function populate(): void {
    populateN++
    state.switchSession(`populate-${populateN}` as never, '/tmp/t17-populate')
    state.getPlanSlugCache().set(state.getSessionId(), 'slug-current')
    state.getPlanSlugCache().set('slug-keeper', 'kept')
    state.addToTotalDurationState(100, 90)
    state.addToToolDuration(10)
    state.addToTotalCostState(0.5, usage(10), 'pop-m1')
    state.addToTotalCostState(0.7, usage(20), 'pop-m2')
    state.addToTotalLinesChanged(3, 1)
    state.setHasUnknownModelCost()
    state.recordUnpricedTurn('pop-m1')
    state.setLastMainRequestId('req-populate')
    state.setLastApiCompletionTimestamp(123456)
    state.setLastAPIRequest({ model: 'pop' } as never)
    state.setPromptCache1hEligible(true)
    state.setSystemPromptSectionCacheEntry('section-a', 'value-a')
    state.setIsInteractive(true)
    state.setAssistantSessionActive(true)
    state.setStrictToolResultPairing(true)
    state.setQuestionPreviewFormat('markdown')
    state.setSessionSovereign(true)
    state.setSessionPermissionModeResolution({ mode: 'sovereign', source: 'launch-flag' })
    state.setSessionTrustAccepted(true)
    state.setSessionPersistenceDisabled(true)
    state.setFlagSettingsPath('/tmp/t17-flag-settings.json')
    state.setFlagSettingsInline({ k: 1 })
    state.setAllowedSettingSources(['userSettings'] as never)
    state.setSessionExtensions(['extension-a'])
    state.setMainThreadAgentType('main-agent')
    state.clearRegisteredHooks()
    state.registerHookCallbacks({ 'tool.before': [cbHook], 'turn.answer': [extHook] } as never)
    state.addInvokedSkill('pop-skill', '/skills/pop', 'content', null)
    state.setEngineModelOverride('claude-opus-4-8' as never)
    state.setModelStrings({ pop: true } as never)
    state.setSdkBetas(['pop-beta'])
    state.setStatsStore({ observe() {} })
  }
  function scopeLeg(label: string, fn: () => void, expected: string[]): void {
    const T = 1_900_000_000_000
    withClock(() => T, () => {
      populate()
      const before = snapshot()
      fn()
      const after = snapshot()
      expectDelta(label, before, after, expected)
    })
  }

  scopeLeg(
    'resetCostState (/clear + login) resets EXACTLY the cost family',
    () => state.resetCostState(),
    [
      'hasUnknownModelCost', 'modelUsage',
      'totalAPIDuration', 'totalAPIDurationWithoutRetries',
      'totalCacheCreationInputTokens', 'totalCacheReadInputTokens',
      'totalCostUSD', 'totalInputTokens', 'totalLinesAdded',
      'totalLinesRemoved', 'totalOutputTokens', 'totalToolDuration',
      'totalWebSearchRequests', 'unpricedTurns',
    ],
  )
  scopeLeg(
    'clearRegisteredHooks touches ONLY the registry',
    () => state.clearRegisteredHooks(),
    ['registeredHooks'],
  )
  scopeLeg(
    'switchSession touches ONLY the identity pair + slug eviction (cost/latches/boot SURVIVE)',
    () => state.switchSession('switch-target-scope' as never, '/tmp/t17-switch-dir'),
    ['planSlugCache', 'sessionId', 'sessionProjectDir'],
  )
  scopeLeg(
    'regenerateSessionId touches ONLY the switch set',
    () => state.regenerateSessionId(),
    ['planSlugCache', 'sessionId', 'sessionProjectDir'],
  )
  scopeLeg(
    'clearSystemPromptSectionState touches ONLY the section cache',
    () => state.clearSystemPromptSectionState(),
    ['systemPromptSectionCache'],
  )
  scopeLeg(
    'clearRegisteredHooks touches ONLY the hook registry',
    () => state.clearRegisteredHooks(),
    ['registeredHooks'],
  )
  scopeLeg(
    'clearRegisteredPluginHooks touches ONLY the hook registry',
    () => state.clearRegisteredExtensionHooks(),
    ['registeredHooks'],
  )

  const sentinel = { settings: {}, errors: [] }
  setSessionSettingsCache(sentinel as never)
  state.setIsInteractive(true)
  check('coupling: posture setters leave the settings cache alone', getSessionSettingsCache() === (sentinel as never))
}

section('LAW PURITY — zero-arg getters do not mutate')
{
  const getterNames = Object.entries(state)
    .filter(([name, fn]) => /^(?:get|is|has|needs|prefer)[A-Za-z0-9_]*$/.test(name) && typeof fn === 'function' && fn.length === 0)
    .map(([name]) => name)
    .sort()
  check(`purity: module sweep found a plausible getter population (${getterNames.length})`, getterNames.length >= 58, String(getterNames.length))
  withClock(() => 2_000_000_000_000, () => {
    const before = snapshot()
    const impure: string[] = []
    for (const name of getterNames) {
      const fn = (state as never as Record<string, () => unknown>)[name]!
      const r1 = ser(fn())
      const r2 = ser(fn())
      if (r1 !== r2) impure.push(`${name} (unstable result)`)
    }
    const after = snapshot()
    const drift = deltaKeys(before, after)
    check('purity: repeated getter calls return stable results', impure.length === 0, impure.join(','))
    check('purity: the full getter sweep left every observable untouched', drift.length === 0, drift.join(','))
  })
}

section('LAW 13 RESET — resetStateForTests totality + the characterized gaps')
{

  state.updateLastInteractionTime()

  let ghostEmissions = 0
  state.onSessionSwitch(() => {
    ghostEmissions++
  })
  state.switchSession('pre-reset-probe' as never)
  check('reset setup: subscriber live before reset', ghostEmissions === 1)
  let ghostCwdBeats = 0
  state.subscribeCwdState(() => {
    ghostCwdBeats++
  })
  state.setCwdState(state.getCwdState())
  check('reset setup: cwd-beat subscriber live before reset', ghostCwdBeats === 1)

  const preResetSessionId = state.getSessionId()
  state.resetStateForTests()

  const postReset = snapshot()
  const allowedToDiffer = new Set(['sessionId', 'lastInteractionTime'])
  const totalityDrift = deltaKeys(bootSnapshot, postReset).filter(k => !allowedToDiffer.has(k))
  check(
    'reset: every observable returns to its boot value (totality, field-by-field)',
    totalityDrift.length === 0,
    totalityDrift.map(k => `${k}: ${bootSnapshot[k]} → ${postReset[k]}`).join(' | '),
  )
  const freshId = state.getSessionId()
  check('reset: sessionId is FRESH (uuid-shaped, differs from pre-reset)', UUID_RE.test(freshId) && freshId !== preResetSessionId && freshId !== bootSessionId)
  check('reset: lastInteractionTime re-stamped to a live timestamp', state.getLastInteractionTime() > 0)

  withClock(() => 2_100_000_000_000, () => {
    const t = state.getLastInteractionTime()
    state.flushInteractionTime()
    check('reset: interaction dirty bit cleared (flush after reset is a no-op)', state.getLastInteractionTime() === t)
  })

  state.switchSession('post-reset-probe' as never)
  check('reset: pre-reset subscribers are GONE (signal cleared)', ghostEmissions === 1, String(ghostEmissions))
  state.setCwdState(state.getCwdState())
  check('reset: pre-reset cwd-beat subscribers are GONE (signal died with the owner)', ghostCwdBeats === 1, String(ghostCwdBeats))

  const savedNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  let threw = false
  try {
    state.resetStateForTests()
  } catch {
    threw = true
  }
  process.env.NODE_ENV = savedNodeEnv
  check('reset: refuses outside NODE_ENV=test (live guard read)', threw)

  process.env.MERCURY_ASSISTANT_DISABLE = 'on'
  state.resetStateForTests()
  check(
    'GAP 1 FLIPPED: the assistant env default IS re-evaluated on instance rebuild (a fresh opt-out wins after resetStateForTests)',
    state.isAssistantFamilyAvailable() === false,
  )
  delete process.env.MERCURY_ASSISTANT_DISABLE
  state.resetStateForTests()
  check('gap 1 corollary: the explicit-flip field itself resets with the instance', state.isAssistantSessionActive() === false)

  state.markScrollActivity()
  state.resetStateForTests()
  check(
    'CHARACTERIZED-GAP: scroll-drain flag is NOT cleared by resetStateForTests (self-clears only via the live debounce timer)',
    state.getIsScrollDraining() === true,
  )
  {
    const keepalive = setInterval(() => {}, 50)
    try {
      await state.waitForScrollIdle()
    } finally {
      clearInterval(keepalive)
    }
  }
  check('gap 2 corollary: the debounce still self-clears afterwards', state.getIsScrollDraining() === false)
}

{
  const byScope: Record<string, number> = {}
  for (const o of OBSERVABLES) byScope[o.scope] = (byScope[o.scope] ?? 0) + 1
  console.log(
    `── scope table: ${OBSERVABLES.length} observables — ` +
      Object.entries(byScope)
        .sort()
        .map(([s, n]) => `${s}:${n}`)
        .join(' · '),
  )
}

rmSync(scratch, { recursive: true, force: true })
rmSync(hermeticHome, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\nnative-core state contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core state contract: green (${checks} checks)`)
