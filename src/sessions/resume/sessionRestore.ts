import { getEngineModelOverride, getSessionId, setEngineModelOverride, setMainThreadAgentType, getLastApiCompletionTimestamp, setLastApiCompletionTimestamp } from '../../boot/process-state/processState.js'
import { restoreCostStateForSession } from '../../models/usage/sessionCost.js'
import type { AppState } from '../../screen/app-state/AppStateStore.js'

import type { AgentDefinition, AgentDefinitionsResult } from '../../crew/agents/agentDefinition.js'
import type { PersistedWorktreeSession } from '../transcripts/transcriptEntries.js'
import type { AssistantMessage, Message } from '../../engine/message-shapes/message.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { FileHistorySnapshot } from '../transcripts/fileHistory.js'
import { fileHistoryRestoreStateFromSnapshots } from '../../tools/engines/change-transaction/fileHistory.js'
import { rearmMissionFromCard } from '../../permissions/guards/mission.js'
import { migrateOrphanedMissionCard } from '../mission-card/missionCard.js'
import { billingSafeRetainedForm, servedModelOfAssistantRow } from '../../models/catalogue/retainedModel.js'
import type { ContentReplacementRecord } from '../../engine/tool-dispatch/toolResultStorage.js'


export type ResumedConversationListing = {
  messages: Message[]
  sessionId?: string
  fullPath?: string
  fileHistorySnapshots?: FileHistorySnapshot[]
  contentReplacements?: ContentReplacementRecord[]
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'coordinator' | 'normal'
  advisor?: boolean
  swarm?: boolean
  model?: string
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

export function lastAssistantTimestamp(messages: ReadonlyArray<{ type: string; timestamp?: string }>): number | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message && message.type === 'assistant' && typeof message.timestamp === 'string') {
      const parsed = Date.parse(message.timestamp)
      return Number.isNaN(parsed) ? null : parsed
    }
  }
  return null
}

export async function restoreSessionStateFromListing(
  result: ResumedConversationListing,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): Promise<void> {
  if (result.fileHistorySnapshots && result.fileHistorySnapshots.length > 0) {
    fileHistoryRestoreStateFromSnapshots(result.fileHistorySnapshots, fileHistory => {
      setAppState(prev => ({ ...prev, fileHistory }))
    })
  }
  if (getLastApiCompletionTimestamp() === null) {
    const lastTimestamp = lastAssistantTimestamp(result.messages)
    if (lastTimestamp !== null) {
      setLastApiCompletionTimestamp(lastTimestamp)
    }
  }
  const adopted = adoptedSessionIdOf(result)
  if (adopted === getSessionId()) {
    await restoreCostStateForSession(adopted, result.fullPath)
  }
  restoreMissionContinuity(result)
}

export function restoreMissionContinuity(
  result: Pick<ResumedConversationListing, 'messages' | 'sessionId'>,
): boolean {
  try {
    const adopted = adoptedSessionIdOf(result)
    migrateOrphanedMissionCard(adopted)
    return rearmMissionFromCard({ cardSessionId: adopted, armSessionId: adopted })
  } catch (error) {
    logForDebugging(`resume: mission re-arm failed: ${String(error)}`)
    return false
  }
}

function adoptedSessionIdOf(result: Pick<ResumedConversationListing, 'messages' | 'sessionId'>): string {
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
  if (!agentSetting) {
    setMainThreadAgentType(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }
  const matched = agentDefinitions.activeAgents.find(agent => agent.agentType === agentSetting)
  if (!matched) {
    setMainThreadAgentType(undefined)
    logForDebugging(`Resumed session's agent "${agentSetting}" is no longer available; using default behavior`)
    return { agentDefinition: undefined, agentType: undefined }
  }
  setMainThreadAgentType(matched.agentType)
  if (matched.model && matched.model !== 'inherit' && getEngineModelOverride() === undefined) {
    setEngineModelOverride(matched.model)
  }
  return { agentDefinition: matched, agentType: matched.agentType }
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

export function restoreConversationModel(result: Pick<ResumedConversationListing, 'messages' | 'model'>): string | null {
  if (getEngineModelOverride() !== undefined) return null
  if (result.model) return result.model
  return restoreConversationModelFromMessages(result.messages)
}
