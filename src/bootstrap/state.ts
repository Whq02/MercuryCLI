// ============================================================================
//  src/bootstrap/state.ts — the frozen runtime-state facade.
//
//  A dependency-graph leaf: every module in the product reads global session
//  facts through this export surface, and the surface is mechanically locked
//  (scripts/core-runtime/prove-state-contract.ts pins the exact runtime export
//  census, the type exports, and the module-privacy of any internal record).
//  Adding or removing an export is a deliberate, prover-updating act.
//
//  Every mutable cell lives on exactly one family owner under
//  src/bootstrap/runtime/; this facade only delegates. Owners are constructed
//  EAGERLY at module evaluation — the session-identity owner's construction
//  mints the boot session id and resolves the cwd trio (realpath + NFC), so
//  those facts exist as soon as this module has evaluated. The owner bindings
//  are mutable so resetStateForTests can rebuild each instance wholesale; the
//  scroll-gate owner is the one deliberate exception (process-scoped, bound
//  immutably, cleared only by its own live debounce timer).
//
//  Nothing outside src/bootstrap/ may import an owner module directly — the
//  contract prover enforces that boundary mechanically.
// ============================================================================
import type { ModelUsage } from '../entrypoints/agentSdkTypes.js'
import type { HookEvent } from '../entrypoints/agentSdkTypes.js'
import type { SessionId } from '../types/ids.js'
import type { ApiRequestParams } from '../types/wire.js'
import type { ModelSetting } from '../utils/model/model.js'
import type { ModelStrings } from '../utils/model/modelStrings.js'
import type { SettingSource } from '../utils/settings/constants.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import { ApiCaptureOwner } from './runtime/api-capture.js'
import { BootConfigOwner } from './runtime/boot-config.js'
import type { ChannelEntry as RuntimeChannelEntry } from './runtime/boot-config.js'
import { CacheLatchOwner } from './runtime/cache-latches.js'
import { CollectionsOwner } from './runtime/collections.js'
import type {
  InvokedSkillInfo as RuntimeInvokedSkillInfo,
} from './runtime/collections.js'
import { InteractionClockOwner } from './runtime/interaction-clock.js'
import { ModeOneShotOwner } from './runtime/mode-one-shots.js'
import { ModelConfigOwner } from './runtime/model-config.js'
import { PostureOwner } from './runtime/posture.js'
import { ScrollGateOwner } from './runtime/scroll-gate.js'
import { SdkInitOwner } from './runtime/sdk-init.js'
import type { RegisteredHookMatcher } from './runtime/sdk-init.js'
import { SessionIdentityOwner } from './runtime/session-identity.js'
import { StatsHandleOwner } from './runtime/stats-handle.js'
import { TurnAccountingOwner } from './runtime/turn-accounting.js'
import { UsageLedgerOwner } from './runtime/usage-ledger.js'

// Re-published owner types (the facade is the sanctioned import point; the
// contract prover greps for these literal `export type` declarations).
export type ChannelEntry = RuntimeChannelEntry
export type InvokedSkillInfo = RuntimeInvokedSkillInfo

// ── eager owner construction (boot-order receipts depend on this) ──────────
let sessionIdentity = new SessionIdentityOwner()
let usageLedger = new UsageLedgerOwner()
let turnAccounting = new TurnAccountingOwner(usageLedger)
let interactionClock = new InteractionClockOwner()
let modelConfig = new ModelConfigOwner()
let posture = new PostureOwner()
let bootConfig = new BootConfigOwner()
let apiCapture = new ApiCaptureOwner()
let modeOneShots = new ModeOneShotOwner()
let cacheLatches = new CacheLatchOwner()
let collections = new CollectionsOwner()
let sdkInit = new SdkInitOwner()
let statsHandle = new StatsHandleOwner()
// Process-scoped and outside the test reset by design — see the header.
const scrollGate = new ScrollGateOwner()

// ═══════════════════════════════════════════════════════════════════════════
// Session identity
// ═══════════════════════════════════════════════════════════════════════════

export function getSessionId(): SessionId {
  return sessionIdentity.sessionId
}

export function regenerateSessionId(
  options: { setCurrentAsParent?: boolean } = {},
): SessionId {
  return sessionIdentity.regenerateSessionId(options)
}

export function getParentSessionId(): SessionId | undefined {
  return sessionIdentity.parentSessionId
}

/** Atomic: the session id and the session project dir change together and
 *  only here; the switch signal fires after the write. */
export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  sessionIdentity.switchSession(sessionId, projectDir)
}

/** Resolves the owner binding at call time, so a subscription made after a
 *  test reset attaches to the rebuilt owner, not the discarded one. */
export function onSessionSwitch(
  listener: (id: SessionId) => void,
): () => void {
  return sessionIdentity.onSessionSwitch(listener)
}

export function getSessionProjectDir(): string | null {
  return sessionIdentity.sessionProjectDir
}

export function getOriginalCwd(): string {
  return sessionIdentity.originalCwd
}

export function getProjectRoot(): string {
  return sessionIdentity.projectRoot
}

export function setOriginalCwd(nextCwd: string): void {
  sessionIdentity.setOriginalCwd(nextCwd)
}

/** Startup `--worktree` only — a mid-session worktree entry must leave the
 *  project identity anchor where the session began. */
export function setProjectRoot(nextCwd: string): void {
  sessionIdentity.setProjectRoot(nextCwd)
}

export function getCwdState(): string {
  return sessionIdentity.cwd
}

export function setCwdState(nextCwd: string): void {
  sessionIdentity.setCwdState(nextCwd)
}

/** The ground-move beat: fires after every setCwdState write with the
 *  normalized value. Resolves the owner binding at call time, so a
 *  subscription made after a test reset attaches to the rebuilt owner,
 *  not the discarded one (the onSessionSwitch law). */
export function subscribeCwdState(
  listener: (cwd: string) => void,
): () => void {
  return sessionIdentity.onCwdChange(listener)
}

export function getPlanSlugCache(): Map<string, string> {
  return sessionIdentity.planSlugCache
}

// ═══════════════════════════════════════════════════════════════════════════
// Usage ledger
// ═══════════════════════════════════════════════════════════════════════════

export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number,
): void {
  usageLedger.addToTotalDurationState(duration, durationWithoutRetries)
}

export function resetTotalDurationStateAndCost_FOR_TESTS_ONLY(): void {
  usageLedger.resetDurationsAndCostForTestsOnly()
}

/** Cost accumulates; the per-model usage entry is a snapshot REPLACE. */
export function addToTotalCostState(
  cost: number,
  usageRecord: ModelUsage,
  modelName: string,
): void {
  usageLedger.addToTotalCostState(cost, usageRecord, modelName)
}

export function getTotalCostUSD(): number {
  return usageLedger.totalCostUSD
}

export function getTotalAPIDuration(): number {
  return usageLedger.totalAPIDuration
}

export function getTotalDuration(): number {
  return usageLedger.getTotalDuration()
}

export function getTotalAPIDurationWithoutRetries(): number {
  return usageLedger.totalAPIDurationWithoutRetries
}

export function getTotalToolDuration(): number {
  return usageLedger.totalToolDuration
}

export function addToTotalLinesChanged(added: number, removed: number): void {
  usageLedger.addToTotalLinesChanged(added, removed)
}

export function getTotalLinesAdded(): number {
  return usageLedger.totalLinesAdded
}

export function getTotalLinesRemoved(): number {
  return usageLedger.totalLinesRemoved
}

export function getTotalInputTokens(): number {
  return usageLedger.getTotalInputTokens()
}

export function getTotalOutputTokens(): number {
  return usageLedger.getTotalOutputTokens()
}

export function getTotalCacheReadInputTokens(): number {
  return usageLedger.getTotalCacheReadInputTokens()
}

export function getTotalCacheCreationInputTokens(): number {
  return usageLedger.getTotalCacheCreationInputTokens()
}

export function getTotalWebSearchRequests(): number {
  return usageLedger.getTotalWebSearchRequests()
}

export function getModelUsage(): { [modelName: string]: ModelUsage } {
  return usageLedger.modelUsage
}

export function getUsageForModel(modelName: string): ModelUsage | undefined {
  return usageLedger.modelUsage[modelName]
}

export function setHasUnknownModelCost(value: boolean = true): void {
  usageLedger.hasUnknownModelCost = value
}

export function hasUnknownModelCost(): boolean {
  return usageLedger.hasUnknownModelCost
}

/** One settled turn the ledger could not price (no rate on file, no
 *  wire-stated cost) — counted per model, never summed as a zero. */
export function recordUnpricedTurn(modelName: string): void {
  usageLedger.recordUnpricedTurn(modelName)
}

export function getUnpricedTurns(): { [modelName: string]: number } {
  return usageLedger.unpricedTurns
}

export function getTotalUnpricedTurns(): number {
  return usageLedger.getTotalUnpricedTurns()
}

/** The /clear + login scope boundary: the whole cost family plus the prompt
 *  correlation id. */
export function resetCostState(): void {
  usageLedger.resetCostState()
  apiCapture.promptId = null
}

export function setCostStateForRestore(restore: {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
  unpricedTurns?: { [modelName: string]: number } | undefined
}): void {
  usageLedger.setCostStateForRestore(restore)
}

// ═══════════════════════════════════════════════════════════════════════════
// Turn accounting
// ═══════════════════════════════════════════════════════════════════════════

/** Dual write: the ledger total and the per-turn triple, one call. */
export function addToToolDuration(duration: number): void {
  turnAccounting.addToToolDuration(duration)
}

export function getTurnToolDurationMs(): number {
  return turnAccounting.turnToolDurationMs
}

export function resetTurnToolDuration(): void {
  turnAccounting.resetTurnToolDuration()
}

export function getTurnToolCount(): number {
  return turnAccounting.turnToolCount
}

export function getTurnHookDurationMs(): number {
  return turnAccounting.turnHookDurationMs
}

export function addToTurnHookDuration(duration: number): void {
  turnAccounting.addToTurnHookDuration(duration)
}

export function resetTurnHookDuration(): void {
  turnAccounting.resetTurnHookDuration()
}

export function getTurnHookCount(): number {
  return turnAccounting.turnHookCount
}

export function getTurnClassifierDurationMs(): number {
  return turnAccounting.turnClassifierDurationMs
}

export function addToTurnClassifierDuration(duration: number): void {
  turnAccounting.addToTurnClassifierDuration(duration)
}

export function resetTurnClassifierDuration(): void {
  turnAccounting.resetTurnClassifierDuration()
}

export function getTurnClassifierCount(): number {
  return turnAccounting.turnClassifierCount
}

export function getTurnOutputTokens(): number {
  return turnAccounting.getTurnOutputTokens()
}

export function getCurrentTurnTokenBudget(): number | null {
  return turnAccounting.getCurrentTurnTokenBudget()
}

export function snapshotOutputTokensForTurn(budget: number | null): void {
  turnAccounting.snapshotOutputTokensForTurn(budget)
}

export function getBudgetContinuationCount(): number {
  return turnAccounting.getBudgetContinuationCount()
}

export function incrementBudgetContinuationCount(): void {
  turnAccounting.incrementBudgetContinuationCount()
}

// ═══════════════════════════════════════════════════════════════════════════
// Interaction clock and scroll gate
// ═══════════════════════════════════════════════════════════════════════════

export function updateLastInteractionTime(immediate?: boolean): void {
  interactionClock.updateLastInteractionTime(immediate)
}

export function flushInteractionTime(): void {
  interactionClock.flushInteractionTime()
}

export function getLastInteractionTime(): number {
  return interactionClock.getLastInteractionTime()
}

export function markScrollActivity(): void {
  scrollGate.markScrollActivity()
}

export function getIsScrollDraining(): boolean {
  return scrollGate.getIsScrollDraining()
}

export function waitForScrollIdle(): Promise<void> {
  return scrollGate.waitForScrollIdle()
}

// ═══════════════════════════════════════════════════════════════════════════
// Model config
// ═══════════════════════════════════════════════════════════════════════════

export function getMainLoopModelOverride(): ModelSetting | undefined {
  return modelConfig.mainLoopModelOverride
}

export function setMainLoopModelOverride(
  model: ModelSetting | undefined,
): void {
  modelConfig.mainLoopModelOverride = model
}

export function getInitialMainLoopModel(): ModelSetting {
  return modelConfig.initialMainLoopModel
}

export function setInitialMainLoopModel(model: ModelSetting): void {
  modelConfig.initialMainLoopModel = model
}

export function getSdkBetas(): string[] | undefined {
  return modelConfig.sdkBetas
}

export function setSdkBetas(betas: string[] | undefined): void {
  modelConfig.sdkBetas = betas
}

export function getModelStrings(): ModelStrings | null {
  return modelConfig.modelStrings
}

export function setModelStrings(strings: ModelStrings): void {
  modelConfig.modelStrings = strings
}

export function resetModelStringsForTestingOnly(): void {
  modelConfig.modelStrings = null
}

// ═══════════════════════════════════════════════════════════════════════════
// Posture
// ═══════════════════════════════════════════════════════════════════════════

/** The negation of the interactive cell — never an independent flag. */
export function getIsNonInteractiveSession(): boolean {
  return !posture.isInteractive
}

/** Marked true ONLY by the one-shot headless entry (a `-p "prompt"` run with
 *  string input); left false for interactive, streaming-input, and any process
 *  that never boots that entry (e.g. proofs). */
export function setHeadlessOneShot(oneShot: boolean): void {
  posture.headlessOneShot = oneShot
}

/**
 * A one-shot headless print run. The self-pacing scheduler is never started
 * here, so a tool whose only effect is a later fire (cron, self-wake) cannot
 * act — the roster must not advertise it. Everything else reads false.
 */
export function getIsSessionOneShotHeadless(): boolean {
  return posture.headlessOneShot
}

export function getIsInteractive(): boolean {
  return posture.isInteractive
}

export function setIsInteractive(value: boolean): void {
  posture.isInteractive = value
}

export function getClientType(): string {
  return posture.clientType
}

export function setClientType(clientType: string): void {
  posture.clientType = clientType
}

export function getSdkAgentProgressSummariesEnabled(): boolean {
  return posture.sdkAgentProgressSummariesEnabled
}

export function setSdkAgentProgressSummariesEnabled(value: boolean): void {
  posture.sdkAgentProgressSummariesEnabled = value
}

/** "The assistant family is available this session": default OR the
 *  explicit session flip. */
export function isAssistantFamilyAvailable(): boolean {
  return posture.isAssistantFamilyAvailable()
}

/** "This session is an away/assistant session": the EXPLICIT flip only —
 *  the default never answers this question. */
export function isAssistantSessionActive(): boolean {
  return posture.isAssistantSessionActive()
}

export function setAssistantSessionActive(active: boolean): void {
  posture.assistantSessionActive = active
}

export function getStrictToolResultPairing(): boolean {
  return posture.strictToolResultPairing
}

export function setStrictToolResultPairing(value: boolean): void {
  posture.strictToolResultPairing = value
}

export function getUserMsgOptIn(): boolean {
  return posture.userMsgOptIn
}

export function setUserMsgOptIn(value: boolean): void {
  posture.userMsgOptIn = value
}

export function getSessionSource(): string | undefined {
  return posture.sessionSource
}

export function setSessionSource(source: string | undefined): void {
  posture.sessionSource = source
}

export function getQuestionPreviewFormat(): 'markdown' | 'html' | undefined {
  return posture.questionPreviewFormat
}

export function setQuestionPreviewFormat(
  format: 'markdown' | 'html' | undefined,
): void {
  posture.questionPreviewFormat = format
}

export function preferThirdPartyAuthentication(): boolean {
  return posture.preferThirdPartyAuthentication()
}

export function setSessionBypassPermissionsMode(value: boolean): void {
  posture.sessionBypassPermissionsMode = value
}

export function getSessionBypassPermissionsMode(): boolean {
  return posture.sessionBypassPermissionsMode
}

export function setSessionTrustAccepted(value: boolean): void {
  posture.sessionTrustAccepted = value
}

export function getSessionTrustAccepted(): boolean {
  return posture.sessionTrustAccepted
}

export function setSessionPersistenceDisabled(value: boolean): void {
  posture.sessionPersistenceDisabled = value
}

export function isSessionPersistenceDisabled(): boolean {
  return posture.sessionPersistenceDisabled
}

export function getIsRemoteMode(): boolean {
  return posture.isRemoteMode
}

export function setIsRemoteMode(value: boolean): void {
  posture.isRemoteMode = value
}

// ═══════════════════════════════════════════════════════════════════════════
// Boot config
// ═══════════════════════════════════════════════════════════════════════════

export function getDirectConnectServerUrl(): string | undefined {
  return bootConfig.directConnectServerUrl
}

export function setDirectConnectServerUrl(url: string | undefined): void {
  bootConfig.directConnectServerUrl = url
}

export function getFlagSettingsPath(): string | undefined {
  return bootConfig.flagSettingsPath
}

export function setFlagSettingsPath(path: string | undefined): void {
  bootConfig.flagSettingsPath = path
}

export function getFlagSettingsInline(): Record<string, unknown> | null {
  return bootConfig.flagSettingsInline
}

export function setFlagSettingsInline(
  settings: Record<string, unknown> | null,
): void {
  bootConfig.flagSettingsInline = settings
}

export function getSessionIngressToken(): string | null | undefined {
  return bootConfig.sessionIngressToken
}

export function setSessionIngressToken(
  token: string | null | undefined,
): void {
  bootConfig.sessionIngressToken = token
}

export function getOauthTokenFromFd(): string | null | undefined {
  return bootConfig.oauthTokenFromFd
}

export function setOauthTokenFromFd(token: string | null | undefined): void {
  bootConfig.oauthTokenFromFd = token
}

export function getApiKeyFromFd(): string | null | undefined {
  return bootConfig.apiKeyFromFd
}

export function setApiKeyFromFd(key: string | null | undefined): void {
  bootConfig.apiKeyFromFd = key
}

export function getAllowedSettingSources(): SettingSource[] {
  return bootConfig.allowedSettingSources
}

export function setAllowedSettingSources(sources: SettingSource[]): void {
  bootConfig.allowedSettingSources = sources
}

export function setSessionExtensions(paths: Array<string>): void {
  bootConfig.sessionExtensions = paths
}

/** The `--extension <path>` folders: approved by the flag for this session only. */
export function getSessionExtensions(): Array<string> {
  return bootConfig.sessionExtensions
}

export function getMainThreadAgentType(): string | undefined {
  return bootConfig.mainThreadAgentType
}

export function setMainThreadAgentType(agentType: string | undefined): void {
  bootConfig.mainThreadAgentType = agentType
}

export function getAddedDirectories(): string[] {
  return bootConfig.addedDirectories
}

export function setAddedDirectories(
  directories: string[],
): void {
  bootConfig.addedDirectories = directories
}

export function getAllowedChannels(): ChannelEntry[] {
  return bootConfig.allowedChannels
}

export function setAllowedChannels(channels: ChannelEntry[]): void {
  bootConfig.allowedChannels = channels
}

export function getHasDevChannels(): boolean {
  return bootConfig.hasDevChannels
}

export function setHasDevChannels(value: boolean): void {
  bootConfig.hasDevChannels = value
}

// ═══════════════════════════════════════════════════════════════════════════
// API capture
// ═══════════════════════════════════════════════════════════════════════════

export function getLastMainRequestId(): string | undefined {
  return apiCapture.lastMainRequestId
}

export function setLastMainRequestId(requestId: string | undefined): void {
  apiCapture.lastMainRequestId = requestId
}

export function getLastApiCompletionTimestamp(): number | null {
  return apiCapture.lastApiCompletionTimestamp
}

export function setLastApiCompletionTimestamp(timestamp: number | null): void {
  apiCapture.lastApiCompletionTimestamp = timestamp
}

export function markPostCompaction(): void {
  apiCapture.markPostCompaction()
}

export function consumePostCompaction(): boolean {
  return apiCapture.consumePostCompaction()
}

export function setLastAPIRequest(
  request: Omit<ApiRequestParams, 'messages'> | null,
): void {
  apiCapture.lastAPIRequest = request
}

export function getLastAPIRequest(): Omit<ApiRequestParams, 'messages'> | null {
  return apiCapture.lastAPIRequest
}

/** Held BY REFERENCE, never cloned — a sharing surface depends on seeing the
 *  live array. */
export function setLastAPIRequestMessages(
  messages: ApiRequestParams['messages'] | null,
): void {
  apiCapture.lastAPIRequestMessages = messages
}

export function getLastAPIRequestMessages():
  | ApiRequestParams['messages']
  | null {
  return apiCapture.lastAPIRequestMessages
}

export function setLastClassifierRequests(requests: unknown[] | null): void {
  apiCapture.lastClassifierRequests = requests
}

export function getLastClassifierRequests(): unknown[] | null {
  return apiCapture.lastClassifierRequests
}

export function setCachedInstructionPrompt(content: string | null): void {
  apiCapture.cachedInstructionPrompt = content
}

export function getCachedInstructionPrompt(): string | null {
  return apiCapture.cachedInstructionPrompt
}

export function getPromptId(): string | null {
  return apiCapture.promptId
}

export function setPromptId(promptId: string | null): void {
  apiCapture.promptId = promptId
}

// ═══════════════════════════════════════════════════════════════════════════
// Mode one-shots
// ═══════════════════════════════════════════════════════════════════════════

export function hasExitedPlanModeInSession(): boolean {
  return modeOneShots.hasExitedPlanMode
}

export function setHasExitedPlanMode(value: boolean): void {
  modeOneShots.hasExitedPlanMode = value
}

export function needsPlanModeExitAttachment(): boolean {
  return modeOneShots.needsPlanModeExitAttachment
}

export function setNeedsPlanModeExitAttachment(value: boolean): void {
  modeOneShots.needsPlanModeExitAttachment = value
}

export function hasEnteredPlanModeThisSession(): boolean {
  return modeOneShots.hasEnteredPlanModeThisSession
}

export function handlePlanModeTransition(
  fromMode: string,
  toMode: string,
): void {
  modeOneShots.handlePlanModeTransition(fromMode, toMode)
}

export function needsAutoModeExitAttachment(): boolean {
  return modeOneShots.needsAutoModeExitAttachment
}

export function setNeedsAutoModeExitAttachment(value: boolean): void {
  modeOneShots.needsAutoModeExitAttachment = value
}

export function handleAutoModeTransition(
  fromMode: string,
  toMode: string,
): void {
  modeOneShots.handleAutoModeTransition(fromMode, toMode)
}

// ═══════════════════════════════════════════════════════════════════════════
// Cache latches and session caches
// ═══════════════════════════════════════════════════════════════════════════

export function getSystemPromptSectionCache(): Map<
  string,
  { key: string | null; value: string | null }
> {
  return cacheLatches.systemPromptSectionCache
}

export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
  key: string | null = null,
): void {
  cacheLatches.systemPromptSectionCache.set(name, { key, value })
}

export function clearSystemPromptSectionState(): void {
  cacheLatches.systemPromptSectionCache.clear()
}

export function getLastEmittedDate(): string | null {
  return cacheLatches.lastEmittedDate
}

export function setLastEmittedDate(date: string | null): void {
  cacheLatches.lastEmittedDate = date
}

export function getPromptCache1hAllowlist(): string[] | null {
  return cacheLatches.promptCache1hAllowlist
}

export function setPromptCache1hAllowlist(allowlist: string[] | null): void {
  cacheLatches.promptCache1hAllowlist = allowlist
}

export function getPromptCache1hEligible(): boolean | null {
  return cacheLatches.promptCache1hEligible
}

export function setPromptCache1hEligible(eligible: boolean | null): void {
  cacheLatches.promptCache1hEligible = eligible
}

export function getAfkModeHeaderLatched(): boolean | null {
  return cacheLatches.afkModeHeaderLatched
}

export function setAfkModeHeaderLatched(value: boolean | null): void {
  cacheLatches.afkModeHeaderLatched = value
}

export function getCacheEditingHeaderLatched(): boolean | null {
  return cacheLatches.cacheEditingHeaderLatched
}

export function setCacheEditingHeaderLatched(value: boolean | null): void {
  cacheLatches.cacheEditingHeaderLatched = value
}

export function getThinkingClearLatched(): boolean | null {
  return cacheLatches.thinkingClearLatched
}

export function setThinkingClearLatched(value: boolean | null): void {
  cacheLatches.thinkingClearLatched = value
}

/** Fired on transcript clear and compaction; the 1-hour prompt-cache pair is
 *  deliberately NOT in this clear set. */
export function clearBetaHeaderLatches(): void {
  cacheLatches.clearBetaHeaderLatches()
}

// ═══════════════════════════════════════════════════════════════════════════
// Session collections
// ═══════════════════════════════════════════════════════════════════════════

export function getAgentColorMap(): Map<string, AgentColorName> {
  return collections.agentColorMap
}

export function getSessionCreatedTeams(): Set<string> {
  return collections.sessionCreatedTeams
}

export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  collections.addInvokedSkill(skillName, skillPath, content, agentId)
}

export function getInvokedSkills(): Map<string, InvokedSkillInfo> {
  return collections.invokedSkills
}

export function getInvokedSkillsForAgent(
  agentId: string | undefined | null,
): Map<string, InvokedSkillInfo> {
  return collections.getInvokedSkillsForAgent(agentId)
}

export function clearInvokedSkills(
  preservedAgentIds?: ReadonlySet<string>,
): void {
  collections.clearInvokedSkills(preservedAgentIds)
}

export function clearInvokedSkillsForAgent(agentId: string): void {
  collections.clearInvokedSkillsForAgent(agentId)
}

// ═══════════════════════════════════════════════════════════════════════════
// SDK init registry
// ═══════════════════════════════════════════════════════════════════════════

export function setInitJsonSchema(
  schema: Record<string, unknown> | null,
): void {
  sdkInit.initJsonSchema = schema
}

export function getInitJsonSchema(): Record<string, unknown> | null {
  return sdkInit.initJsonSchema
}

export function registerHookCallbacks(
  hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>,
): void {
  sdkInit.registerHookCallbacks(hooks)
}

export function getRegisteredHooks(): Partial<
  Record<HookEvent, RegisteredHookMatcher[]>
> | null {
  return sdkInit.registeredHooks
}

export function clearRegisteredHooks(): void {
  sdkInit.registeredHooks = null
}

export function clearRegisteredExtensionHooks(): void {
  sdkInit.clearRegisteredExtensionHooks()
}

export function resetSdkInitState(): void {
  sdkInit.resetSdkInitState()
}

// ═══════════════════════════════════════════════════════════════════════════
// Stats handle and the test reset
// ═══════════════════════════════════════════════════════════════════════════

export function getStatsStore(): {
  observe(name: string, value: number): void
} | null {
  return statsHandle.statsStore
}

export function setStatsStore(
  store: { observe(name: string, value: number): void } | null,
): void {
  statsHandle.statsStore = store
}

/**
 * Rebuilds every family owner wholesale: fresh session identity (new id,
 * re-resolved cwd), a re-evaluated assistant env default, and the old switch
 * signal's subscribers die with the old instance. The scroll gate is
 * deliberately NOT rebuilt — only its live debounce timer clears it.
 */
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests is only available under NODE_ENV=test')
  }
  sessionIdentity = new SessionIdentityOwner()
  usageLedger = new UsageLedgerOwner()
  turnAccounting = new TurnAccountingOwner(usageLedger)
  interactionClock = new InteractionClockOwner()
  modelConfig = new ModelConfigOwner()
  posture = new PostureOwner()
  bootConfig = new BootConfigOwner()
  apiCapture = new ApiCaptureOwner()
  modeOneShots = new ModeOneShotOwner()
  cacheLatches = new CacheLatchOwner()
  collections = new CollectionsOwner()
  sdkInit = new SdkInitOwner()
  statsHandle = new StatsHandleOwner()
}
