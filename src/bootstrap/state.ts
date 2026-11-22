import type { ModelUsage, WorkloadUnpricedTurns, WorkloadUsage } from './runtime/usage-ledger.js'
import type { HookEvent } from '../utils/hooks/contract.js'

export type { ModelUsage, WorkloadUnpricedTurns, WorkloadUsage } from './runtime/usage-ledger.js'
import type { SessionId } from '../types/ids.js'
import type { ApiRequestParams } from '../types/wire.js'
import type { ModelSetting } from '../services/model/model.js'
import type { SessionPermissionModeResolution } from '../utils/permissions/permissionSetup.js'
import type { ModelStrings } from '../utils/model/modelStrings.js'
import type { SessionKind } from '../utils/sessionKind.js'
import type { SettingSource } from '../utils/settings/constants.js'
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
import { resetJevLedger } from '../services/jev/jevLedgerState.js'
import { passedOver } from '../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type InvokedSkillInfo = Unbuilt

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
  return notBuilt('src/bootstrap/state.ts:47')
}

export function regenerateSessionId(): SessionId {
  return sessionIdentity.regenerateSessionId()
}

export function switchSession(
  sessionId: SessionId,
  projectDir?: string | null,
): void {
  return notBuilt('src/bootstrap/state.ts:55')
}

export function onSessionSwitch(
  listener: (id: SessionId) => void,
): () => void {
  return sessionIdentity.onSessionSwitch(listener)
}

export function getSessionProjectDir(): string | null {
  return notBuilt('src/bootstrap/state.ts:68')
}

export function getOriginalCwd(): string {
  return notBuilt('src/bootstrap/state.ts:72')
}

export function getProjectRoot(): string {
  return notBuilt('src/bootstrap/state.ts:76')
}

export function setOriginalCwd(nextCwd: string): void {
  sessionIdentity.setOriginalCwd(nextCwd)
}

export function setProjectRoot(nextCwd: string): void {
  sessionIdentity.setProjectRoot(nextCwd)
}

export function getCwdState(): string {
  return notBuilt('src/bootstrap/state.ts:88')
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
  return notBuilt('src/bootstrap/state.ts:102')
}


export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number,
): void {
  return notBuilt('src/bootstrap/state.ts:107')
}

export function addToTotalCostState(
  cost: number,
  usageRecord: ModelUsage,
  modelName: string,
): void {
  return notBuilt('src/bootstrap/state.ts:114')
}

export function getTotalCostUSD(): number {
  return notBuilt('src/bootstrap/state.ts:122')
}

export function getTotalAPIDuration(): number {
  return notBuilt('src/bootstrap/state.ts:126')
}

export function getTotalDuration(): number {
  return notBuilt('src/bootstrap/state.ts:130')
}

export function getTotalAPIDurationWithoutRetries(): number {
  return notBuilt('src/bootstrap/state.ts:134')
}

export function getTotalToolDuration(): number {
  return notBuilt('src/bootstrap/state.ts:138')
}

export function addToTotalLinesChanged(added: number, removed: number): void {
  return notBuilt('src/bootstrap/state.ts:142')
}

export function getTotalLinesAdded(): number {
  return notBuilt('src/bootstrap/state.ts:146')
}

export function getTotalLinesRemoved(): number {
  return notBuilt('src/bootstrap/state.ts:150')
}

export function getTotalInputTokens(): number {
  return notBuilt('src/bootstrap/state.ts:154')
}

export function getTotalOutputTokens(): number {
  return notBuilt('src/bootstrap/state.ts:158')
}

export function getTotalCacheReadInputTokens(): number {
  return notBuilt('src/bootstrap/state.ts:162')
}

export function getTotalCacheCreationInputTokens(): number {
  return notBuilt('src/bootstrap/state.ts:166')
}

export function getTotalWebSearchRequests(): number {
  return notBuilt('src/bootstrap/state.ts:170')
}

export function getModelUsage(): { [modelName: string]: ModelUsage } {
  return notBuilt('src/bootstrap/state.ts:174')
}

export function getUsageForModel(modelName: string): ModelUsage | undefined {
  return notBuilt('src/bootstrap/state.ts:178')
}

export function setHasUnknownModelCost(value: boolean = true): void {
  usageLedger.hasUnknownModelCost = value
}

export function hasUnknownModelCost(): boolean {
  return notBuilt('src/bootstrap/state.ts:186')
}

export function recordUnpricedTurn(modelName: string): void {
  usageLedger.recordUnpricedTurn(modelName)
}

export function getUnpricedTurns(): { [modelName: string]: number } {
  return notBuilt('src/bootstrap/state.ts:194')
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
  return notBuilt('src/bootstrap/state.ts:218')
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
  return notBuilt('src/bootstrap/state.ts:224')
}


export function addToToolDuration(duration: number): void {
  return notBuilt('src/bootstrap/state.ts:241')
}


export function updateLastInteractionTime(immediate?: boolean): void {
  return notBuilt('src/bootstrap/state.ts:246')
}

export function flushInteractionTime(): void {
  return notBuilt('src/bootstrap/state.ts:250')
}

export function getLastInteractionTime(): number {
  return notBuilt('src/bootstrap/state.ts:254')
}

export function markScrollActivity(): void {
  return notBuilt('src/bootstrap/state.ts:258')
}

export function getIsScrollDraining(): boolean {
  return notBuilt('src/bootstrap/state.ts:262')
}

export function waitForScrollIdle(): Promise<void> {
  return notBuilt('src/bootstrap/state.ts:266')
}


export function getEngineModelOverride(): ModelSetting | undefined {
  return notBuilt('src/bootstrap/state.ts:271')
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
  return notBuilt('src/bootstrap/state.ts:284')
}

export function getSdkBetas(): string[] | undefined {
  return notBuilt('src/bootstrap/state.ts:297')
}

export function setSdkBetas(betas: string[] | undefined): void {
  return notBuilt('src/bootstrap/state.ts:301')
}

export function getModelStrings(): ModelStrings | null {
  return notBuilt('src/bootstrap/state.ts:305')
}

export function setModelStrings(strings: ModelStrings): void {
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

export function getSdkAgentProgressSummariesEnabled(): boolean {
  return posture.sdkAgentProgressSummariesEnabled
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
