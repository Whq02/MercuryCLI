import { getMainLoopModelOverride, getSessionId, setMainLoopModelOverride, setMainThreadAgentType, getLastApiCompletionTimestamp, setLastApiCompletionTimestamp } from '../bootstrap/state.js'
import { restoreCostStateForSession } from '../cost-tracker.js'
import type { AppState } from '../state/AppStateStore.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import type { AgentDefinition, AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import type { PersistedWorktreeSession } from '../types/logs.js'
import type { AssistantMessage, Message } from '../types/message.js'
import type { AttributionState } from './commitAttribution.js'
import { logForDebugging } from './debug.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { fileHistoryRestoreStateFromLog } from './fileHistory.js'
import { rearmMissionFromCard } from './hooks/missionHook.js'
import { migrateOrphanedMissionCard } from '../services/mission/missionCard.js'
import { billingSafeRetainedForm, servedModelOfAssistantRow } from './model/retainedModel.js'
import { initializeTeammateContextFromSession } from './swarm/reconnection.js'
import { isTaskToolsEnabled } from './tasks.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'


export type ResumedConversationLog = {
  messages: Message[]
  sessionId?: string
  fileHistorySnapshots?: FileHistorySnapshot[]
  contentReplacements?: ContentReplacementRecord[]
  teamName?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

const DEFAULT_AGENT_COLOR = 'default'

const INHERIT_MODEL_SENTINEL = 'inherit'

export function lastAssistantTimestamp(messages: ReadonlyArray<{ type: string; timestamp?: string }>): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i]!
    if (row.type !== 'assistant' || typeof row.timestamp !== 'string') continue
    const at = Date.parse(row.timestamp)
    return Number.isFinite(at) ? at : null
  }
  return null
}

export function restoreSessionStateFromLog(
  result: ResumedConversationLog,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  if (result.fileHistorySnapshots && result.fileHistorySnapshots.length > 0) {
    fileHistoryRestoreStateFromLog(result.fileHistorySnapshots, state => {
      setAppState(prev => ({ ...prev, fileHistory: state }))
    })
  }

  if (getLastApiCompletionTimestamp() === null) {
    const lastAssistantAt = lastAssistantTimestamp(result.messages)
    if (lastAssistantAt !== null) setLastApiCompletionTimestamp(lastAssistantAt)
  }

  const adopted = adoptedSessionIdOf(result)
  if (adopted === getSessionId()) restoreCostStateForSession(adopted)

  if (result.teamName && result.agentName) {
    initializeTeammateContextFromSession(setAppState, result.teamName, result.agentName)
  }

  restoreMissionContinuity(result, setAppState)

}

export function restoreMissionContinuity(
  result: Pick<ResumedConversationLog, 'messages' | 'sessionId'>,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): boolean {
  try {
    const adopted = adoptedSessionIdOf(result)
    migrateOrphanedMissionCard(adopted)
    return rearmMissionFromCard(setAppState, { cardSessionId: adopted, armSessionId: adopted })
  } catch (error) {
    logForDebugging(`resume: mission re-arm failed: ${String(error)}`)
    return false
  }
}

function adoptedSessionIdOf(result: Pick<ResumedConversationLog, 'messages' | 'sessionId'>): string {
  const fromMessages = result.messages.find(
    (m): m is Message & { sessionId: string } => typeof (m as { sessionId?: unknown }).sessionId === 'string',
  ) as { sessionId?: string } | undefined
  return String(result.sessionId ?? fromMessages?.sessionId ?? getSessionId())
}

export function computeRestoredAttributionState(result: ResumedConversationLog): AttributionState | undefined {
  void result
  return undefined
}

export function computeStandaloneAgentContext(
  agentName: string | undefined,
  agentColor: string | undefined,
): { name: string; color?: AgentColorName } | undefined {
  if (agentName === undefined && agentColor === undefined) return undefined
  return {
    name: agentName ?? '',
    ...(agentColor !== undefined && agentColor !== DEFAULT_AGENT_COLOR
      ? { color: agentColor as AgentColorName }
      : {}),
  }
}

export function restoreAgentFromSession(
  agentSetting: string | undefined,
  currentAgentDefinition: AgentDefinition | undefined,
  agentDefinitions: AgentDefinitionsResult,
): { agentDefinition: AgentDefinition | undefined; agentType: string | undefined } {
  if (currentAgentDefinition) {
    return { agentDefinition: currentAgentDefinition, agentType: undefined }
  }
  if (agentSetting === undefined) {
    setMainThreadAgentType(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }
  const match = agentDefinitions.activeAgents.find(definition => definition.agentType === agentSetting)
  if (!match) {
    logForDebugging(
      `Resumed session's agent "${agentSetting}" is no longer available; using default behavior`,
    )
    setMainThreadAgentType(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }
  setMainThreadAgentType(agentSetting)
  if (
    getMainLoopModelOverride() === undefined &&
    match.model !== undefined &&
    match.model !== INHERIT_MODEL_SENTINEL
  ) {
    setMainLoopModelOverride(match.model)
  }
  return { agentDefinition: match, agentType: agentSetting }
}


export function restoreConversationModelFromMessages(messages?: Message[]): string | null {
  if (!messages || messages.length === 0) return null
  if (getMainLoopModelOverride() !== undefined) return null

  let servedModel: string | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined) continue
    const served = servedModelOfAssistantRow(message as AssistantMessage)
    if (served !== undefined) {
      servedModel = served
      break
    }
  }
  if (servedModel === undefined) return null

  return billingSafeRetainedForm(servedModel)
}
