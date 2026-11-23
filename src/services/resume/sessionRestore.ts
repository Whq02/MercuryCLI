import { getEngineModelOverride, getSessionId, setEngineModelOverride, setMainThreadAgentType, getLastApiCompletionTimestamp, setLastApiCompletionTimestamp } from '../../bootstrap/state.js'
import { restoreCostStateForSession } from '../../cost-tracker.js'
import type { AppState } from '../../state/AppStateStore.js'

import type { AgentDefinition, AgentDefinitionsResult } from '../../types/agent.js'
import type { PersistedWorktreeSession } from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import type { FileHistorySnapshot } from '../../types/fileHistory.js'
import { fileHistoryRestoreStateFromLog } from '../changeTransaction/fileHistory.js'
import { rearmMissionFromCard } from '../../guards/mission.js'
import { isRecord } from '../../utils/isRecord.js'
import { migrateOrphanedMissionCard } from '../../utils/mission/missionCard.js'
import { billingSafeRetainedForm, servedModelOfAssistantRow } from '../model/retainedModel.js'
import type { ContentReplacementRecord } from '../../utils/toolResultStorage.js'


export type ResumedConversationLog = {
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

export async function restoreSessionStateFromLog(
  result: ResumedConversationLog,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): Promise<void> {
  if (result.fileHistorySnapshots && result.fileHistorySnapshots.length > 0) {
    fileHistoryRestoreStateFromLog(result.fileHistorySnapshots, fileHistory => {
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
  result: Pick<ResumedConversationLog, 'messages' | 'sessionId'>,
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

function adoptedSessionIdOf(result: Pick<ResumedConversationLog, 'messages' | 'sessionId'>): string {
  const rows: readonly unknown[] = result.messages
  let fromMessages: string | undefined
  for (const row of rows) {
    if (isRecord(row) && typeof row.sessionId === 'string') {
      fromMessages = row.sessionId
      break
    }
  }
  return String(result.sessionId ?? fromMessages ?? getSessionId())
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
    logForDebugging(`resume: agent '${agentSetting}' not found in active agents`)
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
    if (message === undefined || message.type !== 'assistant') continue
    const served = servedModelOfAssistantRow(message)
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
