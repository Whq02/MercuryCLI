import { getEngineModelOverride, getSessionId, setEngineModelOverride, setMainThreadAgentType, getLastApiCompletionTimestamp, setLastApiCompletionTimestamp } from '../../bootstrap/state.js'
import { restoreCostStateForSession } from '../../cost-tracker.js'
import type { AppState } from '../../state/AppStateStore.js'

import type { AgentDefinition, AgentDefinitionsResult } from '../../types/agent.js'
import type { PersistedWorktreeSession } from '../../types/logs.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import type { FileHistorySnapshot } from '../../types/fileHistory.js'
import { fileHistoryRestoreStateFromLog } from '../changeTransaction/fileHistory.js'
import { rearmMissionFromCard } from '../../guards/mission.js'
import { migrateOrphanedMissionCard } from '../../utils/mission/missionCard.js'
import { billingSafeRetainedForm, servedModelOfAssistantRow } from '../model/retainedModel.js'
import type { ContentReplacementRecord } from '../../utils/toolResultStorage.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


export type ResumedConversationLog = Unbuilt

export function lastAssistantTimestamp(messages: ReadonlyArray<{ type: string; timestamp?: string }>): number | null {
  return notBuilt('src/services/resume/sessionRestore.ts:40')
}

export async function restoreSessionStateFromLog(
  result: ResumedConversationLog,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): Promise<void> {
  return notBuilt('src/services/resume/sessionRestore.ts:50')
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
  return notBuilt('src/services/resume/sessionRestore.ts:92')
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
