import { getEngineModelOverride, getSessionId, setEngineModelOverride, setMainThreadAgentType, getLastApiCompletionTimestamp, setLastApiCompletionTimestamp } from '../bootstrap/state.js'
import { restoreCostStateForSession } from '../cost-tracker.js'
import type { AppState } from '../state/AppStateStore.js'

import type { AgentDefinition, AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import type { PersistedWorktreeSession } from '../types/logs.js'
import type { AssistantMessage, Message } from '../types/message.js'
import { logForDebugging } from './debug.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { fileHistoryRestoreStateFromLog } from './fileHistory.js'
import { rearmMissionFromCard } from './hooks/missionHook.js'
import { migrateOrphanedMissionCard } from '../services/mission/missionCard.js'
import { billingSafeRetainedForm, servedModelOfAssistantRow } from './model/retainedModel.js'
import { initializeCrewmateContextFromSession } from './crew/reconnection.js'
import { isTaskToolsEnabled } from './tasks.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'


export type ResumedConversationLog = {
  messages: Message[]
  sessionId?: string
  fullPath?: string
  fileHistorySnapshots?: FileHistorySnapshot[]
  contentReplacements?: ContentReplacementRecord[]
  crewName?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'coordinator' | 'normal'
  advisor?: boolean
  model?: string
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

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

export async function restoreSessionStateFromLog(
  result: ResumedConversationLog,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): Promise<void> {
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
  if (adopted === getSessionId()) await restoreCostStateForSession(adopted, result.fullPath)

  if (result.crewName && result.agentName) {
    initializeCrewmateContextFromSession(setAppState, result.crewName, result.agentName)
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
    getEngineModelOverride() === undefined &&
    match.model !== undefined &&
    match.model !== INHERIT_MODEL_SENTINEL
  ) {
    setEngineModelOverride(match.model)
  }
  return { agentDefinition: match, agentType: agentSetting }
}

export function restoreConversationModelFromMessages(messages?: Message[]): string | null {
  if (!messages || messages.length === 0) return null
  if (getEngineModelOverride() !== undefined) return null

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

export function restoreConversationModel(result: Pick<ResumedConversationLog, 'messages' | 'model'>): string | null {
  if (getEngineModelOverride() !== undefined) return null
  if (result.model) return result.model
  return restoreConversationModelFromMessages(result.messages)
}
