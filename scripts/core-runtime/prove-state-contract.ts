#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-state-contract.ts —
//  the runtime-state-owner contract net (the characterization laws,
//  implementation-blind,
//  GREEN ON THE OLD BODY: this is a characterization net over
//  src/bootstrap/state.ts — the module-level singleton + its seven
//  module-scope escapees — built BEFORE the facade/owner decomposition
//  so the cut is mechanically gated.
//
//  The sixteen law families:
//    1  SESSION-SWITCH   — atomic id+projectDir pair · never-carries · slug
//                          eviction · signal exactly-once, emit-after-write,
//                          reentrancy · regenerate parent-carry.
//    2  COST-LEDGER      — accumulate vs REPLACE (modelUsage) · cross-model
//                          token sums · restore startTime math (patched
//                          clock) · reset completeness.
//    3  TURN-WINDOW      — snapshot/delta/budget/continuation-zeroing · the
//                          turn triples · totals survive turn resets.
//    4  ONE-SHOT         — consumePostCompaction · the plan/auto transition
//                          tables over the full mode matrix incl. the
//                          auto↔plan skip rows and quick-toggle clears.
//    5  LATCH            — the four beta-header latches: sticky-on ·
//                          clearBetaHeaderLatches completeness · the
//                          fifth-latch tripwire (source sweep) · 1h
//                          allowlist/eligibility NOT in the clear set.
//    6  ASSISTANT        — child-process env matrix {unset,
// MERCURY_ASSISTANT_DISABLE} (AMENDED: the
//                          retired posture pair renamed)
//                          × {flip, no flip} · alias equivalence ·
//                          isAssistantSessionActive reads ONLY the flip · the
//                          first-read memo latch (characterized).
//    7  INTERACTION-CLOCK— deferred dirty bit · flush-once · immediate.
//    8  SCROLL-DRAIN     — debounce via injected fake timers (delay pinned,
//                          re-mark extends, unref discipline) · real-timer
//                          waitForScrollIdle release · concurrent waiters.
//    9  HOOK-REGISTRY    — merge-on-register order · extensionRoot-discriminated
//                          clear · empty ⇒ null · resetSdkInitState.
//    10 SKILL-TRACKING   — composite keys · agent filters ·
//                          clear-preservation (agentId===null also cleared).
//    11 CRON-SESSION     — removal returns ACTUAL count · unknown ids ⇒ 0 ·
//                          empty input short-circuits without touching the
//                          array reference.
//    12 SLOW-OPS-ABSENT  — the dormant family was DELETED by the cut
//                          (batch 3; the old law's census was the
//                          reachability evidence): the facade exports are
//                          gone, no identifier survives, zero src/
//                          references remain. The absence pin keeps the
//                          family from silently returning.
//    13 RESET            — resetStateForTests TOTALITY field-by-field vs the
//                          boot baseline · fresh sessionId · module-var
//                          zeroing · signal subscribers cleared · the
//                          NODE_ENV guard · the two gap verdicts after the
//                          cut: GAP 1 FLIPPED (the assistant env memo is
//                          instance-scoped and re-evaluates on rebuild — the
//                          sequence's named decision) · GAP 2 PRESERVED (the
//                          scroll-drain gate stays outside the reset; only
//                          the live debounce clears it — the sequence
//                          authorized no flip there).
//    14 CWD-NFC          — NFC normalization on every cwd setter · the boot
//                          leg: symlinked NFD cwd ⇒ realpath'd, NFC,
//                          originalCwd===projectRoot===cwd.
//    15 MODEL-CONFIG     — override/initial/modelStrings/sdkBetas
//                          round-trips + test-only reset.
//    16 API-CAPTURE      — lastAPIRequestMessages is a REFERENCE, not a
//                          clone (the /share reality pin, risk 9) ·
//                          request/classifier/promptId/requestId round-trips.
//
//  Cross-cutting nets the cut is gated on (the mission's mechanical pins):
//    SCOPE-DELTA         — every REAL reset entry point driven against a
//                          fully-populated state; the observable delta must
//                          be EXACTLY the documented field set (the top cut
//                          risk: a scope-classification mistake silently
//                          changing /clear//compact semantics) · the ONE
//                          posture setters carry no outbound coupling.
//    PURITY              — every zero-arg getter is mutation-free (called
//                          twice, full observable snapshot unchanged).
//    EXPORT-SURFACE      — the frozen facade lock: the exact sorted runtime
//                          export census (212 names) + the type exports +
//                          STATE/getInitialState stay module-private.
//    FAN-IN              — the generated import census over src/ (and
//                          scripts/), so the cut's fan-in reduction is
//                          measurable; floor-asserted, exact count printed.
//
//  Honest not-in-process-drivable list: the File-Provider
//  EPERM realpath fallback; real OTel provider wiring (the setMeter factory
//  seam covers the state side); the API-side write of the /share capture
//  (reference-equality is pinned here, the write path stays dist-pinned);
//  agentColorIndex has no accessor at all — facade-invisible, folded into
//  the collections owner by the cut. resetStateForTests runs under
//  NODE_ENV=test — state.ts reads NODE_ENV nowhere else, and this prover
//  imports state.ts alone.
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-state-contract.ts
// ============================================================================
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── hermetic env BEFORE the module under test loads anything ───────────────
process.env.NODE_ENV = 'test'
const hermeticHome = mkdtempSync(join(tmpdir(), 't17-state-home-'))
process.env.MERCURY_CONFIG_DIR = join(hermeticHome, 'config')
process.env.MERCURY_DAEMON_DIR = join(hermeticHome, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(hermeticHome, 'teams')
// Deterministic assistant ground: scrub the opt-out from OUR env before the
// first isAssistantFamilyAvailable() read latches the module memo (children
// get their own explicit cells).
delete process.env.MERCURY_ASSISTANT_DISABLE

import * as state from '../../src/bootstrap/state.js'
import {
  getSessionSettingsCache,
  setSessionSettingsCache,
} from '../../src/utils/settings/settingsCache.js'
import type { SessionId } from '../../src/types/ids.js'
import type { ModelUsage } from '../../src/entrypoints/agentSdkTypes.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const statePath = join(repoRoot, 'src', 'bootstrap', 'state.ts')
const stateSrc = readFileSync(statePath, 'utf8')
const scratch = mkdtempSync(join(tmpdir(), 't17-state-net-'))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(name: string): void {
  console.log(`── ${name}`)
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ── clock seam: state.ts reads Date.now() directly ─────────────────────────
const realDateNow = Date.now.bind(Date)
function withClock<T>(t: () => number, body: () => T): T {
  Date.now = t
  try {
    return body()
  } finally {
    Date.now = realDateNow
  }
}

// ── the observable table (the scope classification) ─
// Every row reads through the PUBLIC facade only. `scope` is the design
// classification — the load-bearing design table the cut will turn into
// owners. pendingPostCompaction has no non-destructive getter (consume-only)
// and agentColorIndex has no accessor at all — both recorded in the header.
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
    // presence-serialization for handle-like objects is fine: the laws only
    // need null↔set transitions plus JSON-visible field changes.
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
  // session identity (conversation)
  { key: 'sessionId', family: 'identity', scope: 'conversation', read: () => state.getSessionId() },
  { key: 'parentSessionId', family: 'identity', scope: 'conversation', read: () => state.getParentSessionId() },
  { key: 'sessionProjectDir', family: 'identity', scope: 'conversation', read: () => state.getSessionProjectDir() },
  { key: 'planSlugCache', family: 'identity', scope: 'session', read: () => state.getPlanSlugCache() },
  // cwd trio (process)
  { key: 'originalCwd', family: 'cwd', scope: 'process', read: () => state.getOriginalCwd() },
  { key: 'projectRoot', family: 'cwd', scope: 'process', read: () => state.getProjectRoot() },
  { key: 'cwdState', family: 'cwd', scope: 'process', read: () => state.getCwdState() },
  // cost/usage ledger (conversation — resetCostState on /clear + login)
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
  // turn accounting (turn)
  { key: 'turnHookDurationMs', family: 'turn', scope: 'turn', read: () => state.getTurnHookDurationMs() },
  { key: 'turnHookCount', family: 'turn', scope: 'turn', read: () => state.getTurnHookCount() },
  { key: 'turnToolDurationMs', family: 'turn', scope: 'turn', read: () => state.getTurnToolDurationMs() },
  { key: 'turnToolCount', family: 'turn', scope: 'turn', read: () => state.getTurnToolCount() },
  { key: 'turnClassifierDurationMs', family: 'turn', scope: 'turn', read: () => state.getTurnClassifierDurationMs() },
  { key: 'turnClassifierCount', family: 'turn', scope: 'turn', read: () => state.getTurnClassifierCount() },
  { key: 'turnOutputTokens', family: 'turn', scope: 'derived', read: () => state.getTurnOutputTokens() },
  { key: 'currentTurnTokenBudget', family: 'turn', scope: 'turn', read: () => state.getCurrentTurnTokenBudget() },
  { key: 'budgetContinuationCount', family: 'turn', scope: 'turn', read: () => state.getBudgetContinuationCount() },
  // interaction clock (process)
  { key: 'lastInteractionTime', family: 'interaction', scope: 'process', read: () => state.getLastInteractionTime() },
  // model config (session)
  { key: 'mainLoopModelOverride', family: 'model', scope: 'session', read: () => state.getMainLoopModelOverride() },
  { key: 'initialMainLoopModel', family: 'model', scope: 'session', read: () => state.getInitialMainLoopModel() },
  { key: 'modelStrings', family: 'model', scope: 'session', read: () => (state.getModelStrings() === null ? null : 'set') },
  { key: 'sdkBetas', family: 'model', scope: 'session', read: () => state.getSdkBetas() },
  // stats handle (process, set once by interactiveHelpers at render boot;
    // the export lock is sized accordingly)
  { key: 'statsStore', family: 'telemetry', scope: 'process', read: () => (state.getStatsStore() === null ? null : 'set') },
  // API capture (conversation)
  { key: 'lastAPIRequest', family: 'apiCapture', scope: 'conversation', read: () => state.getLastAPIRequest() },
  { key: 'lastAPIRequestMessages', family: 'apiCapture', scope: 'conversation', read: () => state.getLastAPIRequestMessages() },
  { key: 'lastClassifierRequests', family: 'apiCapture', scope: 'conversation', read: () => state.getLastClassifierRequests() },
  { key: 'cachedInstructionPrompt', family: 'apiCapture', scope: 'conversation', read: () => state.getCachedInstructionPrompt() },
  { key: 'promptId', family: 'apiCapture', scope: 'conversation', read: () => state.getPromptId() },
  { key: 'lastMainRequestId', family: 'apiCapture', scope: 'conversation', read: () => state.getLastMainRequestId() },
  { key: 'lastApiCompletionTimestamp', family: 'apiCapture', scope: 'conversation', read: () => state.getLastApiCompletionTimestamp() },
  // cache latches (conversation) + session-stable 1h pair + session caches
  { key: 'promptCache1hAllowlist', family: 'latches', scope: 'session', read: () => state.getPromptCache1hAllowlist() },
  { key: 'promptCache1hEligible', family: 'latches', scope: 'session', read: () => state.getPromptCache1hEligible() },
  { key: 'afkModeHeaderLatched', family: 'latches', scope: 'conversation', read: () => state.getAfkModeHeaderLatched() },
  { key: 'cacheEditingHeaderLatched', family: 'latches', scope: 'conversation', read: () => state.getCacheEditingHeaderLatched() },
  { key: 'thinkingClearLatched', family: 'latches', scope: 'conversation', read: () => state.getThinkingClearLatched() },
  { key: 'systemPromptSectionCache', family: 'caches', scope: 'session', read: () => state.getSystemPromptSectionCache() },
  { key: 'lastEmittedDate', family: 'caches', scope: 'session', read: () => state.getLastEmittedDate() },
  // session postures (session)
  { key: 'isInteractive', family: 'posture', scope: 'session', read: () => state.getIsInteractive() },
  { key: 'isNonInteractive', family: 'posture', scope: 'derived', read: () => state.getIsNonInteractiveSession() },
  { key: 'preferThirdPartyAuth', family: 'posture', scope: 'derived', read: () => state.preferThirdPartyAuthentication() },
  { key: 'assistantSessionActive', family: 'posture', scope: 'session', read: () => state.isAssistantSessionActive() },
  { key: 'assistantAvailable', family: 'posture', scope: 'derived', read: () => state.isAssistantFamilyAvailable() },
  { key: 'strictToolResultPairing', family: 'posture', scope: 'session', read: () => state.getStrictToolResultPairing() },
  { key: 'sdkAgentProgressSummariesEnabled', family: 'posture', scope: 'session', read: () => state.getSdkAgentProgressSummariesEnabled() },
  { key: 'userMsgOptIn', family: 'posture', scope: 'session', read: () => state.getUserMsgOptIn() },
  { key: 'clientType', family: 'posture', scope: 'session', read: () => state.getClientType() },
  { key: 'sessionSource', family: 'posture', scope: 'session', read: () => state.getSessionSource() },
  { key: 'questionPreviewFormat', family: 'posture', scope: 'session', read: () => state.getQuestionPreviewFormat() },
  { key: 'isRemoteMode', family: 'posture', scope: 'session', read: () => state.getIsRemoteMode() },
  { key: 'sessionBypassPermissionsMode', family: 'posture', scope: 'session', read: () => state.getSessionBypassPermissionsMode() },
  { key: 'sessionTrustAccepted', family: 'posture', scope: 'session', read: () => state.getSessionTrustAccepted() },
  { key: 'sessionPersistenceDisabled', family: 'posture', scope: 'session', read: () => state.isSessionPersistenceDisabled() },
  // boot config (process, effectively write-once at boot)
  { key: 'flagSettingsPath', family: 'boot', scope: 'process', read: () => state.getFlagSettingsPath() },
  { key: 'flagSettingsInline', family: 'boot', scope: 'process', read: () => state.getFlagSettingsInline() },
  { key: 'allowedSettingSources', family: 'boot', scope: 'process', read: () => state.getAllowedSettingSources() },
  { key: 'sessionIngressToken', family: 'boot', scope: 'process', read: () => state.getSessionIngressToken() },
  { key: 'oauthTokenFromFd', family: 'boot', scope: 'process', read: () => state.getOauthTokenFromFd() },
  { key: 'apiKeyFromFd', family: 'boot', scope: 'process', read: () => state.getApiKeyFromFd() },
  { key: 'sessionExtensions', family: 'boot', scope: 'process', read: () => state.getSessionExtensions() },
  { key: 'allowedChannels', family: 'boot', scope: 'process', read: () => state.getAllowedChannels() },
  { key: 'hasDevChannels', family: 'boot', scope: 'process', read: () => state.getHasDevChannels() },
  { key: 'addedDirectories', family: 'boot', scope: 'process', read: () => state.getAddedDirectories() },
  { key: 'mainThreadAgentType', family: 'boot', scope: 'process', read: () => state.getMainThreadAgentType() },
  { key: 'directConnectServerUrl', family: 'boot', scope: 'process', read: () => state.getDirectConnectServerUrl() },
  // mode-transition one-shots (conversation)
  { key: 'hasExitedPlanMode', family: 'oneShot', scope: 'conversation', read: () => state.hasExitedPlanModeInSession() },
  { key: 'needsPlanModeExitAttachment', family: 'oneShot', scope: 'conversation', read: () => state.needsPlanModeExitAttachment() },
  { key: 'needsAutoModeExitAttachment', family: 'oneShot', scope: 'conversation', read: () => state.needsAutoModeExitAttachment() },
  // SDK init registry (session)
  { key: 'initJsonSchema', family: 'sdkInit', scope: 'session', read: () => state.getInitJsonSchema() },
  { key: 'registeredHooks', family: 'sdkInit', scope: 'session', read: () => state.getRegisteredHooks() },
  // session collections (session)
  { key: 'agentColorMap', family: 'collections', scope: 'session', read: () => state.getAgentColorMap() },
  { key: 'sessionCreatedTeams', family: 'collections', scope: 'session', read: () => state.getSessionCreatedTeams() },
  { key: 'invokedSkills', family: 'collections', scope: 'session', read: () => state.getInvokedSkills() },
  // (the slowOperations observable was DELETED with the dormant family —
  //  batch 3; LAW 12 is now the absence pin)
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

// ── shared fixtures ─────────────────────────────────────────────────────────
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

// Latch the assistant default memo NOW, under the scrubbed env, so every
// later in-process read is deterministic (first-read latch, state.ts:1126).
check('setup: assistant default latches ON under a clean env', state.isAssistantFamilyAvailable() === true)
check('setup: no explicit session flip at boot', state.isAssistantSessionActive() === false)

// The boot baseline — captured before ANY mutation; LAW RESET compares
// against this field-by-field.
const bootSnapshot = snapshot()
const bootSessionId = state.getSessionId()
check('setup: boot sessionId is uuid-shaped', UUID_RE.test(bootSessionId), bootSessionId)
check(
  'setup: boot cwd trio agrees (originalCwd===projectRoot===cwd)',
  state.getOriginalCwd() === state.getProjectRoot() &&
    state.getProjectRoot() === state.getCwdState(),
)

// ════════════════════════════════════════════════════════════════════════════
section('LAW EXPORT-SURFACE — the frozen facade lock')
// The cut keeps state.ts as the export surface: every NAME must survive
// byte-identical (risk 1, the R2 barrel pattern). Runtime census.
{
  const EXPECTED_VALUE_EXPORTS = [
    // batch 3: addSlowOperation + getSlowOperations DELETED with the
    // dormant slow-ops family (the export lock shrinks 212 → 210 — the
    // facade-lock friction working as designed).
    'addInvokedSkill', 'addToToolDuration',
    'addToTotalCostState', 'addToTotalDurationState', 'addToTotalLinesChanged',
    'addToTurnClassifierDuration', 'addToTurnHookDuration', 'clearBetaHeaderLatches',
    'clearInvokedSkills', 'clearInvokedSkillsForAgent', 'clearRegisteredHooks',
    'clearRegisteredExtensionHooks', 'clearSystemPromptSectionState', 'consumePostCompaction',
    'flushInteractionTime', 'getAddedDirectories',
    'getAfkModeHeaderLatched', 'getAgentColorMap', 'getAllowedChannels',
    'getAllowedSettingSources', 'getApiKeyFromFd', 'getBudgetContinuationCount',
    'getCacheEditingHeaderLatched', 'getCachedInstructionPrompt',
    'getClientType', 'getCurrentTurnTokenBudget', 'getCwdState', 'getDirectConnectServerUrl', 'getFlagSettingsInline', 'getFlagSettingsPath',
    'getHasDevChannels', 'getInitJsonSchema', 'getInitialMainLoopModel', 'getSessionExtensions',
    'getInvokedSkills', 'getInvokedSkillsForAgent', 'getIsInteractive',
    'getIsNonInteractiveSession', 'getIsRemoteMode', 'getIsScrollDraining', 'getIsSessionOneShotHeadless', 'isAssistantFamilyAvailable',
    'isAssistantSessionActive', 'getLastAPIRequest', 'getLastAPIRequestMessages',
    'getLastApiCompletionTimestamp', 'getLastClassifierRequests', 'getLastEmittedDate',
    'getLastInteractionTime', 'getLastMainRequestId', 'getMainLoopModelOverride', 'getMainThreadAgentType', 'getModelStrings', 'getModelUsage', 'getOauthTokenFromFd', 'getOriginalCwd',
    'getParentSessionId', 'getPlanSlugCache', 'getProjectRoot',
    'getPromptCache1hAllowlist', 'getPromptCache1hEligible', 'getPromptId',
    'getQuestionPreviewFormat', 'getRegisteredHooks',
    'getSdkAgentProgressSummariesEnabled', 'getSdkBetas', 'getSessionBypassPermissionsMode',
    'getSessionCreatedTeams', 'getSessionId',
    'getSessionIngressToken', 'getSessionProjectDir', 'getSessionSource',
    'getSessionTrustAccepted', 'getStatsStore',
    'getStrictToolResultPairing', 'getSystemPromptSectionCache',
    'getThinkingClearLatched', 'getTotalAPIDuration',
    'getTotalAPIDurationWithoutRetries', 'getTotalCacheCreationInputTokens',
    'getTotalCacheReadInputTokens', 'getTotalCostUSD', 'getTotalDuration',
    'getTotalInputTokens', 'getTotalLinesAdded', 'getTotalLinesRemoved',
    'getTotalOutputTokens', 'getTotalToolDuration', 'getTotalUnpricedTurns', 'getTotalWebSearchRequests',
    'getTurnClassifierCount', 'getTurnClassifierDurationMs',
    'getTurnHookCount', 'getTurnHookDurationMs', 'getTurnOutputTokens', 'getTurnToolCount',
    'getTurnToolDurationMs', 'getUnpricedTurns', 'getUsageForModel', 'getUserMsgOptIn',
    'handleAutoModeTransition', 'handlePlanModeTransition',
    'hasEnteredPlanModeThisSession', 'hasExitedPlanModeInSession',
    'hasUnknownModelCost',
    'incrementBudgetContinuationCount', 'isSessionPersistenceDisabled',
    'markPostCompaction', 'markScrollActivity',
    'needsAutoModeExitAttachment', 'needsPlanModeExitAttachment', 'onSessionSwitch',
    'preferThirdPartyAuthentication', 'recordUnpricedTurn', 'regenerateSessionId', 'registerHookCallbacks',
    'resetCostState', 'resetModelStringsForTestingOnly',
    'resetSdkInitState', 'resetStateForTests',
    'resetTotalDurationStateAndCost_FOR_TESTS_ONLY', 'resetTurnClassifierDuration',
    'resetTurnHookDuration', 'resetTurnToolDuration', 'setAddedDirectories',
    'setAfkModeHeaderLatched', 'setAllowedChannels', 'setAllowedSettingSources',
    'setApiKeyFromFd', 'setCacheEditingHeaderLatched', 'setCachedInstructionPrompt',
    'setClientType', 'setCostStateForRestore', 'setCwdState',
    'setDirectConnectServerUrl',
    'setFlagSettingsInline', 'setFlagSettingsPath', 'setHasDevChannels',
    'setHasExitedPlanMode', 'setHasUnknownModelCost', 'setHeadlessOneShot', 'setInitJsonSchema',
    'setInitialMainLoopModel', 'setSessionExtensions', 'setIsInteractive', 'setIsRemoteMode',
    'setAssistantSessionActive', 'setLastAPIRequest', 'setLastAPIRequestMessages',
    'setLastApiCompletionTimestamp', 'setLastClassifierRequests', 'setLastEmittedDate',
    'setLastMainRequestId',
    'setMainLoopModelOverride', 'setMainThreadAgentType', 'setModelStrings', 'setNeedsAutoModeExitAttachment', 'setNeedsPlanModeExitAttachment',
    'setOauthTokenFromFd', 'setOriginalCwd', 'setProjectRoot', 'setPromptCache1hAllowlist',
    'setPromptCache1hEligible', 'setPromptId', 'setQuestionPreviewFormat',
    'setSdkAgentProgressSummariesEnabled', 'setSdkBetas',
    'setSessionBypassPermissionsMode', 'setSessionIngressToken',
    'setSessionPersistenceDisabled', 'setSessionSource', 'setSessionTrustAccepted',
    'setStatsStore', 'setStrictToolResultPairing', 'setSystemPromptSectionCacheEntry',
    'setThinkingClearLatched', 'setUserMsgOptIn', 'snapshotOutputTokensForTurn', 'subscribeCwdState', 'switchSession',
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
  for (const t of ['ChannelEntry', 'InvokedSkillInfo']) {
    check(`type export survives: ${t}`, new RegExp(`export type ${t}\\b`).test(stateSrc))
  }
  check('STATE singleton stays module-private', !/export\s+const\s+STATE\b/.test(stateSrc))
  check('getInitialState stays module-private', !/export\s+function\s+getInitialState\b/.test(stateSrc))
}

// ════════════════════════════════════════════════════════════════════════════
section('LAW FAN-IN — the import census (the measurable cut baseline)')
{
  const exts = new Set(['.ts', '.tsx'])
  const importRe = /(?:from\s+|import\()\s*['"][^'"]*bootstrap\/state(?:\.js)?['"]/
  function countImporters(root: string): { count: number; files: string[] } {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        const st = statSync(p)
        if (st.isDirectory()) {
          if (name === 'node_modules' || name === '.git') continue
          walk(p)
        } else if (exts.has(name.slice(name.lastIndexOf('.')))) {
          if (importRe.test(readFileSync(p, 'utf8'))) files.push(p)
        }
      }
    }
    walk(root)
    return { count: files.length, files }
  }
  const srcCensus = countImporters(join(repoRoot, 'src'))
  const scriptsCensus = countImporters(join(repoRoot, 'scripts'))
  console.log(
    `  fan-in census: ${srcCensus.count} src importers, ${scriptsCensus.count} script importers` +
      ' (an earlier census measured 317 src — drift is expected as cuts land)',
  )
  check('fan-in census mechanism found importers', srcCensus.count > 0)
  check(
    'fan-in census catches the relative-path variant (screens/REPL.tsx)',
    srcCensus.files.some(f => f.endsWith('screens/REPL.tsx')),
  )
  check(
    'fan-in census catches the OwnerKey boundary (services/run/resolveOwner.ts)',
    srcCensus.files.some(f => f.endsWith('services/run/resolveOwner.ts')),
  )

  // ──: the runtime-owner boundary is MECHANICAL, not comment-convention.
  // The family owners under src/bootstrap/runtime/ are package-internal to
  // the facade: nothing outside src/bootstrap/ may import them directly
  // (the report flagged this as the missing mechanical law).
  const ownerImportRe = /(?:from\s+|import\()\s*['"][^'"]*bootstrap\/runtime\/[^'"]+['"]/
  const violators: string[] = []
  const walkBoundary = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) {
        if (name === 'node_modules' || name === '.git') continue
        if (p.endsWith(join('src', 'bootstrap'))) continue
        walkBoundary(p)
      } else if (exts.has(name.slice(name.lastIndexOf('.')))) {
        if (ownerImportRe.test(readFileSync(p, 'utf8'))) violators.push(p)
      }
    }
  }
  walkBoundary(join(repoRoot, 'src'))
  check(
    'boundary: no file outside src/bootstrap/ imports a runtime family owner directly',
    violators.length === 0,
    violators.join(', '),
  )
}

// ════════════════════════════════════════════════════════════════════════════
section('LAW 12 SLOW-OPS-ABSENT — the dormant family is DELETED')
// CUT (batch 3, the sequence's named law replacement): the OLD LAW 12
// pinned the dormancy — addSlowOperation opened with an unconditional
// `return` (the ant-fold) and getSlowOperations fed only the DevBar panel,
// so the family could never do anything in this build. That law's dormant-
// pair census WAS the reachability evidence for this deletion. The cut
// removed: the STATE field, the dead body, getSlowOperations, the
// utils/slowOperations.ts call, and the DevBar consumer branch. This
// ABSENCE pin keeps the family from silently returning.
{
  const exports = state as never as Record<string, unknown>
  check('absence: addSlowOperation is gone from the facade', !('addSlowOperation' in exports))
  check('absence: getSlowOperations is gone from the facade', !('getSlowOperations' in exports))
  check('absence: no slow-operations identifier survives in state.ts', !/slowOperation/i.test(stateSrc))
  const srcDir = join(repoRoot, 'src')
  const refs = (needle: string): string[] => {
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(p, 'utf8').includes(needle))
          hits.push(p.slice(srcDir.length + 1))
      }
    }
    walk(srcDir)
    return hits.sort()
  }
  check(
    'absence: zero addSlowOperation references anywhere in src/',
    refs('addSlowOperation').length === 0,
    refs('addSlowOperation').join(','),
  )
  check(
    'absence: zero getSlowOperations references anywhere in src/',
    refs('getSlowOperations').length === 0,
    refs('getSlowOperations').join(','),
  )
}

// ════════════════════════════════════════════════════════════════════════════
section('LAW ONE OWNER — the added-directories list has one gatherer')
// The operator's added directories (--add-dir at boot, the workspace in the
// session) are held ONCE: bootConfig.addedDirectories behind
// getAddedDirectories / setAddedDirectories. Two writers exist by design —
// the boot flag pass (main.tsx) and the instruction engine's roots owner
// (services/instructions/engine.ts), which the state-change choke point
// calls once per workspace change — every other consumer reads through the
// getter, no module keeps a second list, and no facade export names the
// other product's instruction file (the stem is composed so this prover
// never matches itself).
{
  const srcDir = join(repoRoot, 'src')
  const filesMatching = (re: RegExp): string[] => {
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name) && re.test(readFileSync(p, 'utf8')))
          hits.push(p.slice(srcDir.length + 1).replaceAll('\\', '/'))
      }
    }
    walk(srcDir)
    return hits.sort()
  }
  const fieldHome = filesMatching(/\baddedDirectories\b/)
  check(
    'one owner: the field lives in the boot-config family and the facade only',
    fieldHome.join(',') === 'bootstrap/runtime/boot-config.ts,bootstrap/state.ts',
    fieldHome.join(','),
  )
  const fieldWriters = filesMatching(/\.addedDirectories\s*=[^=]/)
  check(
    'one owner: the field is assigned by the facade setter alone',
    fieldWriters.join(',') === 'bootstrap/state.ts',
    fieldWriters.join(','),
  )
  const writers = filesMatching(/\bsetAddedDirectories\(/).filter(p => p !== 'bootstrap/state.ts')
  check(
    'one owner: exactly two writers — the boot flag pass (main.tsx) and the instruction engine (services/instructions/engine.ts)',
    writers.join(',') === 'main.tsx,services/instructions/engine.ts',
    writers.join(','),
  )
  const flagReaders = filesMatching(/\bopts\.addDir\b/)
  check(
    'one owner: the --add-dir flag value is read in main.tsx only (no second gatherer)',
    flagReaders.join(',') === 'main.tsx',
    flagReaders.join(','),
  )
  const readers = filesMatching(/\bgetAddedDirectories\(/).filter(p => p !== 'bootstrap/state.ts')
  check(
    "one owner: the readers reach the list through the getter (the engine's root chains, the @import boundary, the nested ladders, skills, the bare-mode law)",
    readers.length >= 6 &&
      ['context.ts', 'skills/loadSkillsDir.ts', 'services/instructions/engine.ts', 'services/instructions/discovery.ts', 'utils/attachments/nestedMemory.ts'].every(p => readers.includes(p)),
    readers.join(','),
  )
  const chokePoint = readFileSync(join(srcDir, 'state', 'onChangeAppState.ts'), 'utf8')
  check(
    'one owner: the state-change choke point mirrors the workspace into the roots (syncInstructionRootsWithWorkspace)',
    chokePoint.includes('syncInstructionRootsWithWorkspace('),
  )
  const syncCallers = filesMatching(/\bsyncInstructionRootsWithWorkspace\(/).filter(p => p !== 'services/instructions/engine.ts')
  check(
    'one owner: the choke point is the only in-session caller of the sync (no mutation site duplicates it)',
    syncCallers.join(',') === 'state/onChangeAppState.ts',
    syncCallers.join(','),
  )
  const exports = state as never as Record<string, unknown>
  check('one owner: the facade exports the getter and the setter', typeof exports.getAddedDirectories === 'function' && typeof exports.setAddedDirectories === 'function')
  const stem = ['Claude', 'Md'].join('')
  check(
    "one owner: no facade export names the other product's instruction file",
    !Object.keys(exports).some(k => k.includes(stem)),
    Object.keys(exports).filter(k => k.includes(stem)).join(','),
  )
  const retiredAccessor = ['Directories', 'For', stem].join('')
  check(
    'one owner: the retired accessor spelling is absent from src/',
    filesMatching(new RegExp(retiredAccessor)).length === 0,
    filesMatching(new RegExp(retiredAccessor)).join(','),
  )
}

// ════════════════════════════════════════════════════════════════════════════
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

  // Characterized: no same-id guard — switching to the current id re-emits.
  state.switchSession(S2)
  check('switch: same-id switch still emits (characterized — no guard)', emissions === 3)

  // Reentrancy: a subscriber that switches again — nested emission runs
  // synchronously, final state is the nested target (createSignal iterates
  // its listener Set with no reentrancy guard; the cut must not add one
  // silently).
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

  // regenerate: parent-carry + fresh uuid + projectDir reset + slug eviction
  state.switchSession(S2, '/tmp/t17-project-b')
  state.getPlanSlugCache().set(S2, 'slug-of-s2')
  const emissionsBeforeRegen = emissions
  const regenerated = state.regenerateSessionId({ setCurrentAsParent: true })
  check('regenerate: does NOT emit the switch signal (characterized)', emissions === emissionsBeforeRegen)
  check('regenerate: returns the live sessionId', regenerated === state.getSessionId())
  check('regenerate: fresh id is uuid-shaped', UUID_RE.test(regenerated), regenerated)
  check('regenerate: fresh id differs', regenerated !== S2)
  check('regenerate: old id becomes parent', state.getParentSessionId() === S2)
  check('regenerate: projectDir reset to null', state.getSessionProjectDir() === null)
  check('regenerate: outgoing slug evicted', !state.getPlanSlugCache().has(S2))
  const parentBefore = state.getParentSessionId()
  state.regenerateSessionId()
  check('regenerate without option: parent unchanged', state.getParentSessionId() === parentBefore)

  unsub()
  const emissionsAtUnsub = emissions
  state.switchSession(S1)
  check('unsubscribe works (no further emissions)', emissions === emissionsAtUnsub)
  state.getPlanSlugCache().delete('bystander')
}

// ════════════════════════════════════════════════════════════════════════════
section('LAW 14 CWD-NFC — normalization on every setter + the boot leg')
{
  const bootOriginal = state.getOriginalCwd()
  const bootRoot = state.getProjectRoot()
  const bootCwd = state.getCwdState()
  const NFD = '/tmp/t17-cafe\u0301-dir' // e + COMBINING ACUTE ACCENT (NFD, escaped so editors cannot normalize it away)
  const NFC = '/tmp/t17-caf\u00e9-dir' // precomposed (NFC)
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

  // Boot leg: a child booted with cwd = a SYMLINK to an NFD-named dir must
  // resolve to the physical path, NFC-normalized, with the trio agreeing.
  // (The File-Provider EPERM fallback at state.ts:270-273 is not drivable
  // in-process — recorded in the header.)
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

// ════════════════════════════════════════════════════════════════════════════
section('LAW 14b CWD-BEAT — subscribeCwdState fires on every setCwdState write')
{
  const bootCwd = state.getCwdState()
  const NFD = '/tmp/t17-beat-cafe\u0301' // e + COMBINING ACUTE ACCENT (NFD, escaped so editors cannot normalize it away)
  const NFC = '/tmp/t17-beat-caf\u00e9' // precomposed (NFC)
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
  // NO same-value guard (the no-same-id law's sibling): a policy re-write of
  // the unchanged cwd re-emits — render consumers dedupe by snapshot compare.
  state.setCwdState(NFD)
  check('cwd-beat: a same-value write re-emits (no guard in the owner)', beats === 2, String(beats))
  unsub()
  state.setCwdState(bootCwd)
  check('cwd-beat: unsubscribe works (no further emissions)', beats === 2, String(beats))
}

// ════════════════════════════════════════════════════════════════════════════
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

    state.setPromptId('prompt-cost-law')
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

// ════════════════════════════════════════════════════════════════════════════
section('LAW 3 TURN-WINDOW — snapshot math · triples · totals survive')
{
  state.resetCostState()
  state.addToTotalCostState(0.1, usage(5), 'turn-m1') // output 10
  check('pre-snapshot turn output equals total (no snapshot yet this state)', state.getTotalOutputTokens() === 10)

  state.snapshotOutputTokensForTurn(500)
  check('snapshot: turn output zeroed at the boundary', state.getTurnOutputTokens() === 0)
  check('snapshot: budget latched', state.getCurrentTurnTokenBudget() === 500)
  check('snapshot: continuation count zeroed', state.getBudgetContinuationCount() === 0)

  state.addToTotalCostState(0.1, usage(15), 'turn-m2') // output +30
  check('turn output = delta since snapshot', state.getTurnOutputTokens() === 30)
  state.incrementBudgetContinuationCount()
  state.incrementBudgetContinuationCount()
  check('continuation count increments', state.getBudgetContinuationCount() === 2)

  state.snapshotOutputTokensForTurn(null)
  check('fresh snapshot: budget can be null', state.getCurrentTurnTokenBudget() === null)
  check('fresh snapshot: continuation count re-zeroed', state.getBudgetContinuationCount() === 0)
  check('fresh snapshot: turn output re-zeroed', state.getTurnOutputTokens() === 0)

  // the turn triples — and the total/turn coupling of addToToolDuration
  state.resetTurnHookDuration()
  state.addToTurnHookDuration(10)
  state.addToTurnHookDuration(15)
  check('hook triple: duration sums', state.getTurnHookDurationMs() === 25)
  check('hook triple: count tracks calls', state.getTurnHookCount() === 2)
  state.resetTurnHookDuration()
  check('hook triple: reset zeroes both', state.getTurnHookDurationMs() === 0 && state.getTurnHookCount() === 0)

  const totalToolBefore = state.getTotalToolDuration()
  state.resetTurnToolDuration()
  state.addToToolDuration(40)
  check('tool add: turn duration + count', state.getTurnToolDurationMs() === 40 && state.getTurnToolCount() === 1)
  check('tool add: TOTAL accumulates in the same call', state.getTotalToolDuration() === totalToolBefore + 40)
  state.resetTurnToolDuration()
  check('tool triple: turn reset zeroes turn side', state.getTurnToolDurationMs() === 0 && state.getTurnToolCount() === 0)
  check('tool triple: the TOTAL survives the turn reset (scope pin)', state.getTotalToolDuration() === totalToolBefore + 40)

  state.resetTurnClassifierDuration()
  state.addToTurnClassifierDuration(7)
  check('classifier triple: duration + count', state.getTurnClassifierDurationMs() === 7 && state.getTurnClassifierCount() === 1)
  state.resetTurnClassifierDuration()
  check('classifier triple: reset zeroes both', state.getTurnClassifierDurationMs() === 0 && state.getTurnClassifierCount() === 0)
}

// ════════════════════════════════════════════════════════════════════════════
section('LAW 4 ONE-SHOT — postCompaction · the plan/auto transition tables')
{
  check('postCompaction: initially unarmed', state.consumePostCompaction() === false)
  state.markPostCompaction()
  check('postCompaction: consume returns true once', state.consumePostCompaction() === true)
  check('postCompaction: auto-reset after consume', state.consumePostCompaction() === false)
  state.markPostCompaction()
  state.markPostCompaction()
  check('postCompaction: double-mark still single-consume', state.consumePostCompaction() === true && state.consumePostCompaction() === false)

  const MODES = ['default', 'strategy', 'flow', 'implement'] as const
  for (const prior of [false, true]) {
    for (const from of MODES) {
      for (const to of MODES) {
        state.setNeedsPlanModeExitAttachment(prior)
        state.handlePlanModeTransition(from, to)
        const expected =
          to === 'strategy' && from !== 'strategy'
            ? false
            : from === 'strategy' && to !== 'strategy'
              ? true
              : prior
        check(
          `plan table: ${from}→${to} (prior=${prior}) ⇒ ${expected}`,
          state.needsPlanModeExitAttachment() === expected,
        )
      }
    }
  }
  for (const prior of [false, true]) {
    for (const from of MODES) {
      for (const to of MODES) {
        state.setNeedsAutoModeExitAttachment(prior)
        state.handleAutoModeTransition(from, to)
        const skipped =
          (from === 'flow' && to === 'strategy') || (from === 'strategy' && to === 'flow')
        const expected = skipped
          ? prior
          : to === 'flow' && from !== 'flow'
            ? false
            : from === 'flow' && to !== 'flow'
              ? true
              : prior
        check(
          `auto table: ${from}→${to} (prior=${prior}) ⇒ ${expected}${skipped ? ' [skip row]' : ''}`,
          state.needsAutoModeExitAttachment() === expected,
        )
      }
    }
  }
  state.setNeedsPlanModeExitAttachment(false)
  state.setNeedsAutoModeExitAttachment(false)

  // ── LAW 4b: mode-exit one-shots are SESSION-SCOPED
  // — a cold process replaying a stale persisted mode at boot arms nothing.
  {
    const { ModeOneShotOwner } = await import('../../src/bootstrap/runtime/mode-one-shots.ts')
    const cold = new ModeOneShotOwner()
    cold.handleAutoModeTransition('flow', 'default')
    check('NEW-2: cold auto-exit (never entered this process) arms NO one-shot', cold.needsAutoModeExitAttachment === false)
    const warm = new ModeOneShotOwner()
    warm.handleAutoModeTransition('default', 'flow')
    warm.handleAutoModeTransition('flow', 'default')
    check('NEW-2: entered-then-exited auto arms the one-shot', warm.needsAutoModeExitAttachment === true)
    const p = new ModeOneShotOwner()
    p.handlePlanModeTransition('default', 'strategy')
    check('NEW-2: plan-mode entry recorded for the injector referent', p.hasEnteredPlanModeThisSession === true)
    const injector = readFileSync(join(repoRoot, 'src/utils/attachments/modeLifecycles.ts'), 'utf8')
    check('NEW-2: plan-exit injector validates the referent (entered OR real plan) before injecting',
      injector.includes('!hasEnteredPlanModeThisSession() && !planExists'))
  }

  check('hasExitedPlanMode: starts false this session', state.hasExitedPlanModeInSession() === false)
  state.setHasExitedPlanMode(true)
  check('hasExitedPlanMode: round-trips', state.hasExitedPlanModeInSession() === true)
  state.setHasExitedPlanMode(false)
}

// ════════════════════════════════════════════════════════════════════════════
section('LAW 5 LATCH — sticky beta headers · clear completeness · tripwire')
{
  state.clearBetaHeaderLatches()
  check('latches: all three null after clear', state.getAfkModeHeaderLatched() === null && state.getCacheEditingHeaderLatched() === null && state.getThinkingClearLatched() === null)

  state.setAfkModeHeaderLatched(true)
  state.setCacheEditingHeaderLatched(true)
  state.setThinkingClearLatched(true)
  state.setPromptCache1hAllowlist(['acct-a'])
  state.setPromptCache1hEligible(true)

  // sticky across unrelated mutations (a dropped latch is a silent
  // cache-bust cost bug — invisible to every other suite)
  state.addToTotalCostState(0.01, usage(1), 'latch-noise')
  state.setIsInteractive(true)
  state.switchSession('33333333-3333-4333-8333-333333333333' as SessionId)
  check('latches: survive unrelated mutations incl. switchSession', state.getAfkModeHeaderLatched() === true && state.getCacheEditingHeaderLatched() === true && state.getThinkingClearLatched() === true)
  state.setIsInteractive(false)

  // characterized: sticky-on is CALLER discipline — the setter itself accepts false
  state.setAfkModeHeaderLatched(false)
  check('latches: setter accepts false (stickiness is caller discipline — characterized)', state.getAfkModeHeaderLatched() === false)
  state.setAfkModeHeaderLatched(true)

  state.clearBetaHeaderLatches()
  check('clearBetaHeaderLatches: nulls ALL THREE', state.getAfkModeHeaderLatched() === null && state.getCacheEditingHeaderLatched() === null && state.getThinkingClearLatched() === null)
  check('clearBetaHeaderLatches: 1h allowlist NOT in the clear set (session-scoped)', ser(state.getPromptCache1hAllowlist()) === ser(['acct-a']))
  check('clearBetaHeaderLatches: 1h eligibility NOT in the clear set (session-latched)', state.getPromptCache1hEligible() === true)
  state.setPromptCache1hAllowlist(null)
  state.setPromptCache1hEligible(null)

  // the fourth-latch tripwire: every `*Latched` field in the bootstrap state
  // estate must appear in the clearBetaHeaderLatches body — a new latch that
  // skips the clear fails HERE, not in production billing.
  // CUT (batch 1): the latch family moved behind the frozen facade into
  // src/bootstrap/runtime/cache-latches.ts, so the sweep now covers BOTH the
  // facade source and the owner file (a latch reintroduced in either place
  // is caught). The law's semantics are unchanged — this is the sequence's
  // "the LATCH law is the net" leg following the family across the move.
  const latchOwnerSrc = readFileSync(
    join(repoRoot, 'src', 'bootstrap', 'runtime', 'cache-latches.ts'),
    'utf8',
  )
  const latchFields = [
    ...new Set([
      ...[...stateSrc.matchAll(/^ {2}(\w+Latched)[:=]/gm)].map(m => m[1]!),
      ...[...latchOwnerSrc.matchAll(/^ {2}(\w+Latched)[:=]/gm)].map(m => m[1]!),
    ]),
  ].sort()
  check(
    'tripwire: exactly the three *Latched fields exist',
    JSON.stringify(latchFields) ===
      JSON.stringify(['afkModeHeaderLatched', 'cacheEditingHeaderLatched', 'thinkingClearLatched']),
    latchFields.join(','),
  )
  const clearBody = latchOwnerSrc.match(/clearBetaHeaderLatches\(\): void \{([\s\S]*?)\n {2}\}/)?.[1] ?? ''
  for (const f of latchFields) {
    check(`tripwire: clearBetaHeaderLatches nulls ${f}`, new RegExp(`this\\.${f} = null`).test(clearBody))
  }
}

// ════════════════════════════════════════════════════════════════════════════
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
  // the first-read memo latch, in a hermetic child: env flips AFTER the
  // first read do not change the default (current truth — the cut's posture
  // owner keeps or consciously dissolves this, prover updated with it)
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
  // in-process confirmation against OUR latched memo
  process.env.MERCURY_ASSISTANT_DISABLE = 'on'
  check('assistant memo (in-process): env flip after first read is ignored', state.isAssistantFamilyAvailable() === true)
  delete process.env.MERCURY_ASSISTANT_DISABLE
}

// ════════════════════════════════════════════════════════════════════════════
section('LAW 7 INTERACTION-CLOCK — deferred dirty bit · flush-once · immediate')
{
  const T = 1_800_000_000_000
  withClock(() => T, () => {
    state.flushInteractionTime() // drain any prior dirty bit deterministically
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

// ════════════════════════════════════════════════════════════════════════════
section('LAW 8 SCROLL-DRAIN — debounce · unref discipline · idle release')
{
  // Leg A — injected fake timers: fully deterministic debounce mechanics.
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

  // Leg B — real timers: waitForScrollIdle resolves after the drain window,
  // including for CONCURRENT waiters. A ref'd keepalive interval guarantees
  // event-loop liveness while the only pending timers are unref'd.
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

// ════════════════════════════════════════════════════════════════════════════
section('LAW 9 HOOK-REGISTRY — merge order · extensionRoot clear · empty ⇒ null')
{
  const cb1 = { tag: 'cb1' }
  const cb2 = { tag: 'cb2' }
  const ext1 = { tag: 'ext1', extensionRoot: '/extensions/one' }
  const extOnly = { tag: 'extOnly', extensionRoot: '/extensions/two' }

  state.clearRegisteredHooks()
  check('registry: starts null after clear', state.getRegisteredHooks() === null)
  state.registerHookCallbacks({ PreToolUse: [cb1] } as never)
  state.registerHookCallbacks({ PreToolUse: [cb2], Stop: [ext1] } as never)
  const reg = state.getRegisteredHooks() as never as Record<string, Array<{ tag: string }>>
  check('registry: repeated registration MERGES, order preserved', reg.PreToolUse?.length === 2 && reg.PreToolUse[0] === (cb1 as never) && reg.PreToolUse[1] === (cb2 as never))
  check('registry: second event registered', reg.Stop?.length === 1 && reg.Stop[0] === (ext1 as never))

  state.clearRegisteredExtensionHooks()
  const afterClear = state.getRegisteredHooks() as never as Record<string, Array<{ tag: string }>>
  check('extension clear: extensionRoot matchers dropped, event key removed when emptied', afterClear !== null && afterClear.Stop === undefined)
  check('extension clear: callback matchers survive', afterClear.PreToolUse?.length === 2)

  state.clearRegisteredHooks()
  state.registerHookCallbacks({ SessionStart: [extOnly] } as never)
  state.clearRegisteredExtensionHooks()
  check('extension clear: all-extension registry collapses to null', state.getRegisteredHooks() === null)
  state.clearRegisteredExtensionHooks()
  check('extension clear: idempotent on null', state.getRegisteredHooks() === null)

  const schema = { type: 'object' }
  state.setInitJsonSchema(schema)
  check('init schema: stored by reference', state.getInitJsonSchema() === schema)
  state.registerHookCallbacks({ PreToolUse: [cb1] } as never)
  state.resetSdkInitState()
  check('resetSdkInitState: nulls schema AND hooks', state.getInitJsonSchema() === null && state.getRegisteredHooks() === null)
}

// ════════════════════════════════════════════════════════════════════════════
section('LAW 10 SKILL-TRACKING — composite keys · filters · preservation')
{
  const T = 1_800_000_100_000
  withClock(() => T, () => {
    state.clearInvokedSkills()
    state.addInvokedSkill('alpha', '/skills/alpha', 'content-main', null)
    state.addInvokedSkill('alpha', '/skills/alpha', 'content-agent1', 'agent1')
    check('skills: composite keys prevent cross-agent overwrite', state.getInvokedSkills().size === 2)
    check('skills: main-thread key shape `:name`', state.getInvokedSkills().get(':alpha')?.content === 'content-main')
    check('skills: agent key shape `agent:name`', state.getInvokedSkills().get('agent1:alpha')?.content === 'content-agent1')

    const forNull = state.getInvokedSkillsForAgent(null)
    check('skills: filter agentId=null returns only main-thread entries', forNull.size === 1 && forNull.has(':alpha'))
    const forUndef = state.getInvokedSkillsForAgent(undefined)
    check('skills: undefined normalizes to null in the filter', forUndef.size === 1 && forUndef.has(':alpha'))
    const forA1 = state.getInvokedSkillsForAgent('agent1')
    check('skills: filter agentId=agent1 exact', forA1.size === 1 && forA1.has('agent1:alpha'))

    state.addInvokedSkill('beta', '/skills/beta', 'c', 'agent2')
    state.clearInvokedSkillsForAgent('agent2')
    check('skills: per-agent clear removes only that agent', state.getInvokedSkills().size === 2 && !state.getInvokedSkills().has('agent2:beta'))

    state.addInvokedSkill('beta', '/skills/beta', 'c', 'agent2')
    state.clearInvokedSkills(new Set(['agent1']))
    check(
      'skills: preserved-set clear drops agentId===null AND non-preserved agents, keeps preserved',
      state.getInvokedSkills().size === 1 && state.getInvokedSkills().has('agent1:alpha'),
      [...state.getInvokedSkills().keys()].join(','),
    )
    state.clearInvokedSkills()
    check('skills: bare clear empties everything', state.getInvokedSkills().size === 0)
    state.clearInvokedSkills(new Set())
    check('skills: empty preserved set behaves as bare clear (no throw)', state.getInvokedSkills().size === 0)
  })
}

// (LAW 11 CRON-SESSION retired with the session cron store —
// a schedule is a session fact on the daemon record now; the
// store's laws live in scripts/daemon/prove-saturn-core.ts §A.)

// ════════════════════════════════════════════════════════════════════════════
section('LAW 16 API-CAPTURE — reference semantics (the /share reality pin)')
{
  const msgs: Array<{ role: string; content: string }> = [{ role: 'user', content: 'hello' }]
  state.setLastAPIRequestMessages(msgs as never)
  check('capture: messages stored by REFERENCE, not clone (risk 9)', state.getLastAPIRequestMessages() === (msgs as never))
  msgs.push({ role: 'assistant', content: 'reply' })
  check('capture: post-capture mutations are visible through the getter', (state.getLastAPIRequestMessages() as never as unknown[]).length === 2)
  state.setLastAPIRequestMessages(null)
  check('capture: messages nullable', state.getLastAPIRequestMessages() === null)

  const req = { model: 'model-req', max_tokens: 1 }
  state.setLastAPIRequest(req as never)
  check('capture: request params stored by reference', state.getLastAPIRequest() === (req as never))
  const classifiers = [{ kind: 'auto-mode' }]
  state.setLastClassifierRequests(classifiers)
  check('capture: classifier requests stored by reference', state.getLastClassifierRequests() === classifiers)
  state.setLastClassifierRequests(null)

  state.setCachedInstructionPrompt('instruction-prompt-body')
  check('capture: the instruction-prompt cache round-trips', state.getCachedInstructionPrompt() === 'instruction-prompt-body')
  state.setCachedInstructionPrompt(null)

  state.setPromptId('prompt-uuid-1')
  check('capture: promptId round-trips', state.getPromptId() === 'prompt-uuid-1')
  state.setPromptId(null)
  state.setLastMainRequestId('req_abc123')
  check('capture: lastMainRequestId round-trips', state.getLastMainRequestId() === 'req_abc123')
  state.setLastApiCompletionTimestamp(1_700_000_000_123)
  check('capture: lastApiCompletionTimestamp round-trips', state.getLastApiCompletionTimestamp() === 1_700_000_000_123)
  state.setLastAPIRequest(null)
}

// ════════════════════════════════════════════════════════════════════════════
section('LAW 15 MODEL-CONFIG — override/initial/strings/betas round-trips')
{
  state.setMainLoopModelOverride('claude-opus-4-8' as never)
  check('model: override round-trips', state.getMainLoopModelOverride() === ('claude-opus-4-8' as never))
  state.setMainLoopModelOverride(undefined)
  check('model: override accepts undefined (cleared)', state.getMainLoopModelOverride() === undefined)
  state.setInitialMainLoopModel('claude-sonnet-5' as never)
  check('model: initial round-trips', state.getInitialMainLoopModel() === ('claude-sonnet-5' as never))
  const strings = { fromEnv: 'x' }
  state.setModelStrings(strings as never)
  check('model: modelStrings stored by reference', state.getModelStrings() === (strings as never))
  state.resetModelStringsForTestingOnly()
  check('model: test-only reset nulls modelStrings', state.getModelStrings() === null)
  const betas = ['context-1m-2025-08-07']
  state.setSdkBetas(betas)
  check('model: sdkBetas stored by reference', state.getSdkBetas() === betas)
  state.setSdkBetas(undefined)
  check('model: sdkBetas clearable', state.getSdkBetas() === undefined)
  state.setInitialMainLoopModel(null)
}

// ════════════════════════════════════════════════════════════════════════════
section('LAW SCOPE-DELTA — every reset entry point, exact field-by-field')
// The top cut risk (risk 3): a field moved to the wrong owner
// silently changes /clear, /compact, resume, or login semantics. Each REAL
// reset entry point runs against a fully-populated state; the observable
// delta must be EXACTLY the documented set — nothing more (a wrongly-reset
// survivor), nothing less (a wrongly-surviving resettable).
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
    state.addToTurnHookDuration(5)
    state.addToTurnClassifierDuration(7)
    state.addToTotalCostState(0.5, usage(10), 'pop-m1')
    state.addToTotalCostState(0.7, usage(20), 'pop-m2')
    state.snapshotOutputTokensForTurn(500)
    state.incrementBudgetContinuationCount()
    state.addToTotalLinesChanged(3, 1)
    state.setHasUnknownModelCost()
    state.recordUnpricedTurn('pop-m1')
    state.setPromptId('prompt-populate')
    state.setLastMainRequestId('req-populate')
    state.setLastApiCompletionTimestamp(123456)
    state.setLastAPIRequest({ model: 'pop' } as never)
    state.setLastAPIRequestMessages([{ role: 'user', content: 'pop' }] as never)
    state.setLastClassifierRequests(['pop'])
    state.setCachedInstructionPrompt('pop-cmd')
    state.markPostCompaction()
    state.setAfkModeHeaderLatched(true)
    state.setCacheEditingHeaderLatched(true)
    state.setThinkingClearLatched(true)
    state.setPromptCache1hAllowlist(['pop'])
    state.setPromptCache1hEligible(true)
    state.setSystemPromptSectionCacheEntry('section-a', 'value-a')
    state.setLastEmittedDate('2026-07-16')
    state.setIsInteractive(true)
    state.setAssistantSessionActive(true)
    state.setStrictToolResultPairing(true)
    state.setSdkAgentProgressSummariesEnabled(true)
    state.setUserMsgOptIn(true)
    state.setSessionSource('populate')
    state.setQuestionPreviewFormat('markdown')
    state.setIsRemoteMode(true)
    state.setSessionBypassPermissionsMode(true)
    state.setSessionTrustAccepted(true)
    state.setSessionPersistenceDisabled(true)
    state.setFlagSettingsPath('/tmp/t17-flag-settings.json')
    state.setFlagSettingsInline({ k: 1 })
    state.setAllowedSettingSources(['userSettings'] as never)
    state.setSessionIngressToken('ingress-token')
    state.setOauthTokenFromFd('oauth-token')
    state.setApiKeyFromFd('api-key')
    state.setSessionExtensions(['extension-a'])
    state.setAllowedChannels([{ kind: 'server', name: 'chan' }])
    state.setHasDevChannels(true)
    state.setAddedDirectories(['/tmp/extra'])
    state.setMainThreadAgentType('main-agent')
    state.setDirectConnectServerUrl('http://localhost:1')
    state.setHasExitedPlanMode(true)
    state.setNeedsPlanModeExitAttachment(true)
    state.setNeedsAutoModeExitAttachment(true)
    state.setInitJsonSchema({ scope: 'delta' })
    state.clearRegisteredHooks()
    state.registerHookCallbacks({ PreToolUse: [cbHook], Stop: [extHook] } as never)
    state.getAgentColorMap().set('agent-a', 'blue' as never)
    state.getSessionCreatedTeams().add('team-populate')
    state.addInvokedSkill('pop-skill', '/skills/pop', 'content', null)
    state.setMainLoopModelOverride('claude-opus-4-8' as never)
    state.setInitialMainLoopModel('claude-sonnet-5' as never)
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
    'resetCostState (/clear + login) resets EXACTLY the cost family + promptId',
    () => state.resetCostState(),
    [
      'hasUnknownModelCost', 'modelUsage', 'promptId',
      'totalAPIDuration', 'totalAPIDurationWithoutRetries',
      'totalCacheCreationInputTokens', 'totalCacheReadInputTokens',
      'totalCostUSD', 'totalInputTokens', 'totalLinesAdded',
      'totalLinesRemoved', 'totalOutputTokens', 'totalToolDuration',
      'totalWebSearchRequests', 'turnOutputTokens', 'unpricedTurns',
    ],
  )
  scopeLeg(
    'clearBetaHeaderLatches (/clear + /compact) touches ONLY the three latches',
    () => state.clearBetaHeaderLatches(),
    ['afkModeHeaderLatched', 'cacheEditingHeaderLatched', 'thinkingClearLatched'],
  )
  scopeLeg(
    'resetSdkInitState touches ONLY schema + hooks',
    () => state.resetSdkInitState(),
    ['initJsonSchema', 'registeredHooks'],
  )
  scopeLeg(
    'switchSession touches ONLY the identity pair + slug eviction (cost/latches/boot SURVIVE)',
    () => state.switchSession('switch-target-scope' as never, '/tmp/t17-switch-dir'),
    ['planSlugCache', 'sessionId', 'sessionProjectDir'],
  )
  scopeLeg(
    'regenerateSessionId({setCurrentAsParent}) adds ONLY the parent to the switch set',
    () => state.regenerateSessionId({ setCurrentAsParent: true }),
    ['parentSessionId', 'planSlugCache', 'sessionId', 'sessionProjectDir'],
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
  scopeLeg(
    'clearInvokedSkills touches ONLY invokedSkills',
    () => state.clearInvokedSkills(),
    ['invokedSkills'],
  )
  scopeLeg(
    'resetTotalDurationStateAndCost_FOR_TESTS_ONLY: durations + cost only',
    () => state.resetTotalDurationStateAndCost_FOR_TESTS_ONLY(),
    ['totalAPIDuration', 'totalAPIDurationWithoutRetries', 'totalCostUSD'],
  )
  scopeLeg('resetTurnHookDuration: the hook pair only', () => state.resetTurnHookDuration(), ['turnHookCount', 'turnHookDurationMs'])
  scopeLeg('resetTurnToolDuration: the tool pair only', () => state.resetTurnToolDuration(), ['turnToolCount', 'turnToolDurationMs'])
  scopeLeg('resetTurnClassifierDuration: the classifier pair only', () => state.resetTurnClassifierDuration(), ['turnClassifierCount', 'turnClassifierDurationMs'])
  scopeLeg('resetModelStringsForTestingOnly: modelStrings only', () => state.resetModelStringsForTestingOnly(), ['modelStrings'])

  // Posture setters carry NO outbound mutation coupling: none may touch the
  // settings cache.
  const sentinel = { settings: {}, errors: [] }
  setSessionSettingsCache(sentinel as never)
  state.setIsInteractive(true)
  state.setIsRemoteMode(false)
  check('coupling: posture setters leave the settings cache alone', getSessionSettingsCache() === (sentinel as never))
}

// ════════════════════════════════════════════════════════════════════════════
section('LAW PURITY — zero-arg getters do not mutate')
{
  // Every zero-arg exported reader, enumerated FROM SOURCE so a new getter
  // auto-joins the sweep. Clock frozen: getTotalDuration reads Date.now.
  const getterNames = [
    ...stateSrc.matchAll(/^export function ((?:get|is|has|needs|prefer)[A-Za-z0-9_]*)\(\s*\)/gm),
  ]
    .map(m => m[1]!)
    .sort()
  // Floor AMENDED: the retired estate took three
  // facade getters (the session cron store + the scheduled-tasks flag +
  // the availability alias) — 88 stands, and the sweep still auto-joins
  // every future getter.
  check(`purity: source sweep found a plausible getter population (${getterNames.length})`, getterNames.length >= 86, String(getterNames.length))
  const missingFromModule = getterNames.filter(n => typeof (state as never as Record<string, unknown>)[n] !== 'function')
  check('purity: every swept getter exists on the module', missingFromModule.length === 0, missingFromModule.join(','))
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

// ════════════════════════════════════════════════════════════════════════════
section('LAW 13 RESET — resetStateForTests totality + the characterized gaps')
{
  // Mutate every family (SCOPE-DELTA already populated heavily). There is no OTel
  // meter/counter factory leg (no telemetry estate
  // ); the stats handle is the family's one observable and is
  // populated by SCOPE-DELTA's populate() above.

  // dirty the module-scope escapees the reset DOES own
  state.snapshotOutputTokensForTurn(999)
  state.incrementBudgetContinuationCount()
  state.updateLastInteractionTime() // dirty bit armed, not flushed
  state.markPostCompaction()

  // a live subscriber that must NOT survive the reset
  let ghostEmissions = 0
  state.onSessionSwitch(() => {
    ghostEmissions++
  })
  state.switchSession('pre-reset-probe' as never)
  check('reset setup: subscriber live before reset', ghostEmissions === 1)
  // the cwd-beat signal obeys the same reset law (it lives on the owner)
  let ghostCwdBeats = 0
  state.subscribeCwdState(() => {
    ghostCwdBeats++
  })
  state.setCwdState(state.getCwdState())
  check('reset setup: cwd-beat subscriber live before reset', ghostCwdBeats === 1)

  const preResetSessionId = state.getSessionId()
  state.resetStateForTests()

  // field-by-field totality vs the boot baseline (fresh sessionId EXPECTED;
  // lastInteractionTime is clock-stamped at re-init — asserted separately)
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

  // module-scope escapees the reset owns
  check('reset: turn-window snapshot vars zeroed (turnOutput 0 on empty usage)', state.getTurnOutputTokens() === 0)
  check('reset: turn budget nulled', state.getCurrentTurnTokenBudget() === null)
  check('reset: budget continuation zeroed', state.getBudgetContinuationCount() === 0)
  check('reset: pending postCompaction cleared', state.consumePostCompaction() === false)
  withClock(() => 2_100_000_000_000, () => {
    const t = state.getLastInteractionTime()
    state.flushInteractionTime()
    check('reset: interaction dirty bit cleared (flush after reset is a no-op)', state.getLastInteractionTime() === t)
  })

  // signal subscribers cleared: the pre-reset ghost must not hear post-reset switches
  state.switchSession('post-reset-probe' as never)
  check('reset: pre-reset subscribers are GONE (signal cleared)', ghostEmissions === 1, String(ghostEmissions))
  state.setCwdState(state.getCwdState())
  check('reset: pre-reset cwd-beat subscribers are GONE (signal died with the owner)', ghostCwdBeats === 1, String(ghostCwdBeats))

  // the NODE_ENV guard
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

  // ── CHARACTERIZED-GAP 1 — FLIPPED by the cut (batch 4c, the
  // sequence's named decision): the assistant default memo is now an
  // INSTANCE field of the posture owner and resetStateForTests rebuilds the
  // instance, so the env default IS re-evaluated after a reset — the
  // cross-test pollution quirk is dissolved. Production
  // behavior is unchanged: within one instance the first-read latch still
  // holds (LAW 6's memo checks above stay green), and resetStateForTests is
  // NODE_ENV=test-only.
  process.env.MERCURY_ASSISTANT_DISABLE = 'on'
  state.resetStateForTests()
  check(
    'GAP 1 FLIPPED: the assistant env default IS re-evaluated on instance rebuild (a fresh opt-out wins after resetStateForTests)',
    state.isAssistantFamilyAvailable() === false,
  )
  delete process.env.MERCURY_ASSISTANT_DISABLE
  // Re-latch the fresh default under the clean env before later legs read it.
  state.resetStateForTests()
  check('gap 1 corollary: the explicit-flip field itself resets with the instance', state.isAssistantSessionActive() === false)

  // ── CHARACTERIZED-GAP 2: the scroll-drain flag survives the reset.
  // Current truth — scrollDraining/scrollDrainTimer are module-scope and not
  // in resetStateForTests (state.ts:784, "no test-reset needed" is half-true:
  // the flag only self-clears when the debounce timer fires). GREEN here by
  // design; the new owner's resetForTests() rebuild dissolves it.
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

// ════════════════════════════════════════════════════════════════════════════
// the scope table, printed as the machine-readable classification artifact
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
