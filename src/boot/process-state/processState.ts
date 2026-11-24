import type { ModelUsage, WorkloadUnpricedTurns, WorkloadUsage } from './runtime/usage-ledger.js'
import type { HookEvent } from '../../integrations/event-hooks/contract.js'

export type { ModelUsage, WorkloadUnpricedTurns, WorkloadUsage } from './runtime/usage-ledger.js'
import type { SessionId } from '../../sessions/transcripts/ids.js'
import type { ApiRequestParams } from '../../engine/message-shapes/wire.js'
import type { ModelSetting } from '../../models/catalogue/engineModel.js'
import type { SessionPermissionModeResolution } from '../../permissions/rules/permissionSetup.js'
import type { PinnedModelIds } from '../../models/facts/pinnedModelIds.js'
import type { SessionKind } from '../../daemon/concourse-workers/sessionKind.js'
import type { SettingSource } from '../../platform/settings/settingSources.js'
import { ApiCaptureOwner } from './runtime/api-capture.js'
import { BootConfigOwner } from './runtime/boot-config.js'
import { CacheLatchOwner } from './runtime/cache-latches.js'
import { CollectionsOwner } from './runtime/collections.js'
import type {
  InvokedSkillInfo as RuntimeInvokedSkillInfo,
} from './runtime/collections.js'
import { InteractionClockOwner } from './runtime/interaction-clock.js'
import { ModelConfigOwner } from './runtime/model-config.js'
import { PostureOwner } from './runtime/posture.js'
import { ScrollGateOwner } from './runtime/scroll-gate.js'
import { HookRegistryOwner } from './runtime/hook-registry.js'
import type { RegisteredHookMatcher } from './runtime/hook-registry.js'
import { SessionIdentityOwner } from './runtime/session-identity.js'
import { StatsHandleOwner } from './runtime/stats-handle.js'
import { UsageLedgerOwner } from './runtime/usage-ledger.js'
import { resetJevLedger } from '../../models/jev/jevLedgerState.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export type InvokedSkillInfo = RuntimeInvokedSkillInfo

let sessionIdentity = new SessionIdentityOwner()
let usageLedger = new UsageLedgerOwner()
let interactionClock = new InteractionClockOwner()
let modelConfig = new ModelConfigOwner()
let posture = new PostureOwner()
let bootConfig = new BootConfigOwner()
let apiCapture = new ApiCaptureOwner()
let cacheLatches = new CacheLatchOwner()
let collections = new CollectionsOwner()
let hookRegistry = new HookRegistryOwner()
let statsHandle = new StatsHandleOwner()
const scrollGate = new ScrollGateOwner()


export function getSessionId(): SessionId {
  return sessionIdentity.sessionId
}

export function regenerateSessionId(): SessionId {
  return sessionIdentity.regenerateSessionId()
}

export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  sessionIdentity.switchSession(sessionId, projectDir)
}

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

export function setProjectRoot(nextCwd: string): void {
  sessionIdentity.setProjectRoot(nextCwd)
}

export function getCwdState(): string {
  return sessionIdentity.cwd
}

export function setCwdState(nextCwd: string): void {
  sessionIdentity.setCwdState(nextCwd)
}

export function subscribeCwdState(
  listener: (cwd: string) => void,
): () => void {
  return sessionIdentity.onCwdChange(listener)
}

export function getPlanSlugCache(): Map<string, string> {
  return sessionIdentity.planSlugCache
}


export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number,
): void {
  usageLedger.addToTotalDurationState(duration, durationWithoutRetries)
}

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

export function recordUnpricedTurn(modelName: string): void {
  usageLedger.recordUnpricedTurn(modelName)
}

export function getUnpricedTurns(): { [modelName: string]: number } {
  return usageLedger.unpricedTurns
}

export function getTotalUnpricedTurns(): number {
  return usageLedger.getTotalUnpricedTurns()
}

export function addToWorkloadUsageState(workload: string, delta: ModelUsage, modelName: string): void {
  usageLedger.addToWorkloadUsageState(workload, delta, modelName)
}

export function recordWorkloadUnpricedTurn(workload: string, modelName: string): void {
  usageLedger.recordWorkloadUnpricedTurn(workload, modelName)
}

export function getWorkloadUsage(): WorkloadUsage {
  return usageLedger.workloadUsage
}

export function getWorkloadUnpricedTurns(): WorkloadUnpricedTurns {
  return usageLedger.workloadUnpricedTurns
}

export function resetCostState(): void {
  usageLedger.resetCostState()
  resetJevLedger()
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
  workloadUsage?: WorkloadUsage | undefined
  workloadUnpricedTurns?: WorkloadUnpricedTurns | undefined
}): void {
  usageLedger.setCostStateForRestore(restore)
}


export function addToToolDuration(duration: number): void {
  usageLedger.addToolDuration(duration)
}


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


export function getEngineModelOverride(): ModelSetting | undefined {
  return modelConfig.engineModelOverride
}

const engineModelOverrideListeners = new Set<(model: ModelSetting | undefined) => void>()

export function subscribeEngineModelOverride(listener: (model: ModelSetting | undefined) => void): () => void {
  engineModelOverrideListeners.add(listener)
  return () => {
    engineModelOverrideListeners.delete(listener)
  }
}

export function setEngineModelOverride(
  model: ModelSetting | undefined,
): void {
  modelConfig.engineModelOverride = model
  for (const listener of engineModelOverrideListeners) {
    try {
      listener(model)
    } catch (error) {
      passedOver(error)
    }
  }
}

export function getSdkBetas(): string[] | undefined {
  return modelConfig.sdkBetas
}

export function setSdkBetas(betas: string[] | undefined): void {
  modelConfig.sdkBetas = betas
}

export function getModelStrings(): PinnedModelIds | null {
  return modelConfig.modelStrings
}

export function setModelStrings(strings: PinnedModelIds): void {
  modelConfig.modelStrings = strings
}


export function getIsNonInteractiveSession(): boolean {
  return !posture.isInteractive
}

export function setHeadlessOneShot(oneShot: boolean): void {
  posture.headlessOneShot = oneShot
}

export function getIsSessionOneShotHeadless(): boolean {
  return posture.headlessOneShot
}

export function setRunInputClosed(closed: boolean): void {
  posture.runInputClosed = closed
}

export function isRunInputClosed(): boolean {
  return posture.runInputClosed
}

export function getIsInteractive(): boolean {
  return posture.isInteractive
}

export type AskChannel = 'operator' | 'sdk' | 'none'

export function setAskChannel(channel: AskChannel): void {
  posture.askChannel = channel
}

export function getAskChannel(): AskChannel {
  return posture.askChannel
}

export function canAnswerAsks(): boolean {
  return posture.askChannel !== 'none'
}

export function setSessionKind(kind: SessionKind): void {
  posture.sessionKind = kind
}

export function getSessionKind(): SessionKind {
  return posture.sessionKind
}

export function setIsInteractive(value: boolean): void {
  posture.isInteractive = value
}

export function setClientType(clientType: string): void {
  posture.clientType = clientType
}

export function isAssistantFamilyAvailable(): boolean {
  return posture.isAssistantFamilyAvailable()
}

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

export function setSessionSovereign(value: boolean): void {
  posture.sessionBypassPermissionsMode = value
}

export function getSessionSovereign(): boolean {
  return posture.sessionBypassPermissionsMode
}

export function getSessionPermissionModeResolution(): Readonly<SessionPermissionModeResolution> | null {
  return posture.permissionModeResolution
}

export function setSessionPermissionModeResolution(resolution: SessionPermissionModeResolution): void {
  posture.permissionModeResolution = Object.freeze({ ...resolution })
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


export function getDirectConnectServerUrl(): string | undefined {
  return bootConfig.directConnectServerUrl
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

export function getAllowedSettingSources(): SettingSource[] {
  return bootConfig.allowedSettingSources
}

export function setAllowedSettingSources(sources: SettingSource[]): void {
  bootConfig.allowedSettingSources = sources
}

export function setSessionExtensions(paths: Array<string>): void {
  bootConfig.sessionExtensions = paths
}

export function getSessionExtensions(): Array<string> {
  return bootConfig.sessionExtensions
}

export function getMainThreadAgentType(): string | undefined {
  return bootConfig.mainThreadAgentType
}

export function setMainThreadAgentType(agentType: string | undefined): void {
  bootConfig.mainThreadAgentType = agentType
}


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

export function setLastAPIRequest(
  request: Omit<ApiRequestParams, 'messages'> | null,
): void {
  apiCapture.lastAPIRequest = request
}

export function getLastAPIRequest(): Omit<ApiRequestParams, 'messages'> | null {
  return apiCapture.lastAPIRequest
}

export function getPromptId(): string | null {
  return apiCapture.promptId
}


export function getSystemPromptSectionCache(): Map<
  string,
  { key: string | null; value: string | null; byKey?: Map<string, string | null> }
> {
  return cacheLatches.systemPromptSectionCache
}

export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
  key: string | null = null,
): void {
  if (key === null) {
    cacheLatches.systemPromptSectionCache.set(name, { key, value })
    return
  }
  const byKey = cacheLatches.systemPromptSectionCache.get(name)?.byKey ?? new Map<string, string | null>()
  byKey.set(key, value)
  cacheLatches.systemPromptSectionCache.set(name, { key, value, byKey })
}

export function clearSystemPromptSectionState(): void {
  cacheLatches.systemPromptSectionCache.clear()
}

export function getPromptCache1hEligible(): boolean | null {
  return cacheLatches.promptCache1hEligible
}

export function setPromptCache1hEligible(eligible: boolean | null): void {
  cacheLatches.promptCache1hEligible = eligible
}

export function getCacheEditingHeaderLatched(): boolean | null {
  return cacheLatches.cacheEditingHeaderLatched
}

export function clearBetaHeaderLatches(): void {
  cacheLatches.clearBetaHeaderLatches()
}


export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  collections.addInvokedSkill(skillName, skillPath, content, agentId)
}

export function getInvokedSkillsForAgent(
  agentId: string | undefined | null,
): Map<string, InvokedSkillInfo> {
  return collections.getInvokedSkillsForAgent(agentId)
}

export function clearInvokedSkillsForAgent(agentId: string): void {
  collections.clearInvokedSkillsForAgent(agentId)
}


export function registerHookCallbacks(
  hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>,
): void {
  hookRegistry.registerHookCallbacks(hooks)
}

export function getRegisteredHooks(): Partial<
  Record<HookEvent, RegisteredHookMatcher[]>
> | null {
  return hookRegistry.registeredHooks
}

export function clearRegisteredHooks(): void {
  hookRegistry.registeredHooks = null
}

export function clearRegisteredExtensionHooks(): void {
  hookRegistry.clearRegisteredExtensionHooks()
}


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

export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests is only available under NODE_ENV=test')
  }
  sessionIdentity = new SessionIdentityOwner()
  usageLedger = new UsageLedgerOwner()
  interactionClock = new InteractionClockOwner()
  modelConfig = new ModelConfigOwner()
  posture = new PostureOwner()
  bootConfig = new BootConfigOwner()
  apiCapture = new ApiCaptureOwner()
  cacheLatches = new CacheLatchOwner()
  collections = new CollectionsOwner()
  hookRegistry = new HookRegistryOwner()
  statsHandle = new StatsHandleOwner()
}
