import { dirname } from 'node:path'

import {
  clearSystemPromptSectionState,
  getMainLoopModelOverride,
  getSessionId,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  setOriginalCwd,
  switchSession,
} from '../bootstrap/state.js'
import { restoreCostStateForSession } from '../cost-tracker.js'
import { clearInstructionFileCaches } from '../services/instructions/engine.js'
import type { AppState } from '../state/AppStateStore.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import type { AgentDefinition, AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.js'
import type { SessionId } from '../types/ids.js'
import type { PersistedWorktreeSession } from '../types/logs.js'
import type { AssistantMessage, Message } from '../types/message.js'
import { renameRecordingForSession } from './asciicast.js'
import type { AttributionState } from './commitAttribution.js'
import { updateSessionName } from './concurrentSessions.js'
import { logForDebugging } from './debug.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { fileHistoryRestoreStateFromLog } from './fileHistory.js'
import { rearmMissionFromCard } from './hooks/missionHook.js'
import { migrateOrphanedMissionCard } from '../services/mission/missionCard.js'
import { billingSafeRetainedForm, servedModelOfAssistantRow } from './model/retainedModel.js'
import { getPlansDirectory } from './plans.js'
import { restoreSessionMetadata, saveWorktreeState } from './sessionStorage/logs.js'
import { initializeTeammateContextFromSession } from './swarm/reconnection.js'
import {
  adoptResumedSessionFile,
  recordContentReplacement,
  resetSessionFilePointer,
} from './sessionStorage/writer.js'
import { setCwd } from './Shell.js'
import { isTodoV2Enabled } from './tasks.js'
import type { TodoList } from './todo/types.js'
import { TodoListSchema } from './todo/types.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import type { WorktreeSession } from './worktree.js'
import { getCurrentWorktreeSession, restoreWorktreeSession } from './worktree.js'


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

export function extractTodosFromMessages(messages: Message[]): TodoList {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    const todoUses = content.filter(
      block => (block as { type?: string; name?: string }).type === 'tool_use' &&
        (block as { name?: string }).name === TODO_WRITE_TOOL_NAME,
    )
    if (todoUses.length === 0) continue
    const input = (todoUses[todoUses.length - 1] as { input?: unknown }).input
    if (typeof input !== 'object' || input === null) return []
    const parsed = TodoListSchema().safeParse((input as { todos?: unknown }).todos)
    return parsed.success ? parsed.data : []
  }
  return []
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

  if (!isTodoV2Enabled() && result.messages.length > 0) {
    const todos = extractTodosFromMessages(result.messages)
    if (todos.length > 0) {
      const sessionId = getSessionId()
      setAppState(prev => ({ ...prev, todos: { ...prev.todos, [sessionId]: todos } }))
    }
  }

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
    const fromMessages = result.messages.find(
      (m): m is Message & { sessionId: string } =>
        typeof (m as { sessionId?: unknown }).sessionId === 'string',
    ) as { sessionId?: string } | undefined
    const adopted = String(result.sessionId ?? fromMessages?.sessionId ?? getSessionId())
    migrateOrphanedMissionCard(adopted)
    return rearmMissionFromCard(setAppState, { cardSessionId: adopted, armSessionId: adopted })
  } catch (error) {
    logForDebugging(`resume: mission re-arm failed: ${String(error)}`)
    return false
  }
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

function invalidateWorktreeSensitiveCaches(): void {
  clearInstructionFileCaches()
  clearSystemPromptSectionState()
  getPlansDirectory.cache.clear()
}

export function restoreWorktreeForResume(
  worktreeSession: PersistedWorktreeSession | null | undefined,
): void {
  const freshWorktree = getCurrentWorktreeSession()
  if (freshWorktree !== null) {
    saveWorktreeState(freshWorktree)
    return
  }
  if (!worktreeSession) return

  try {
    process.chdir(worktreeSession.worktreePath)
  } catch {
    saveWorktreeState(null)
    return
  }
  setCwd(worktreeSession.worktreePath)
  setOriginalCwd(worktreeSession.worktreePath)
  restoreWorktreeSession(worktreeSession as WorktreeSession)
  invalidateWorktreeSensitiveCaches()
}

export function exitRestoredWorktree(): void {
  const current = getCurrentWorktreeSession()
  if (current === null) return
  restoreWorktreeSession(null)
  saveWorktreeState(null)
  invalidateWorktreeSensitiveCaches()
  try {
    process.chdir(current.originalCwd)
  } catch {
    return
  }
  setCwd(current.originalCwd)
  setOriginalCwd(current.originalCwd)
}

export type ProcessedResume = {
  messages: Message[]
  fileHistorySnapshots: FileHistorySnapshot[]
  contentReplacements: ContentReplacementRecord[]
  agentName: string | undefined
  agentColor: AgentColorName | undefined
  restoredAgentDef: AgentDefinition | undefined
  initialState: AppState
}

export async function processResumedConversation(
  result: ResumedConversationLog,
  opts: {
    forkSession: boolean
    sessionIdOverride?: string
    transcriptPath?: string
    includeAttribution?: boolean
  },
  context: {
    mainThreadAgentDefinition: AgentDefinition | undefined
    agentDefinitions: AgentDefinitionsResult
    currentCwd: string
    cliAgents: AgentDefinition[]
    initialState: AppState
  },
): Promise<ProcessedResume> {
  if (!opts.forkSession) {
    const adoptedSessionId = (opts.sessionIdOverride ??
      result.sessionId ??
      (
        result.messages.find(
          m => typeof (m as { sessionId?: unknown }).sessionId === 'string',
        ) as { sessionId?: string } | undefined
      )?.sessionId) as SessionId
    switchSession(adoptedSessionId, opts.transcriptPath ? dirname(opts.transcriptPath) : null)
    await renameRecordingForSession()
    await resetSessionFilePointer()
    restoreCostStateForSession(adoptedSessionId)
  } else if (result.contentReplacements && result.contentReplacements.length > 0) {
    await recordContentReplacement(result.contentReplacements)
  }

  restoreSessionMetadata({
    customTitle: result.customTitle,
    tag: result.tag,
    agentName: result.agentName,
    agentColor: result.agentColor,
    agentSetting: result.agentSetting,
    mode: result.mode,
    prNumber: result.prNumber,
    prUrl: result.prUrl,
    prRepository: result.prRepository,
    ...(opts.forkSession ? {} : { worktreeSession: result.worktreeSession }),
  })

  if (!opts.forkSession) {
    restoreWorktreeForResume(result.worktreeSession)
    adoptResumedSessionFile()
  }

  const { agentDefinition: restoredAgentDefinition, agentType } = restoreAgentFromSession(
    result.agentSetting,
    context.mainThreadAgentDefinition,
    context.agentDefinitions,
  )
  const standaloneAgentContext = computeStandaloneAgentContext(result.agentName, result.agentColor)
  const attributionState = opts.includeAttribution ? computeRestoredAttributionState(result) : undefined

  if (result.agentName !== undefined) {
    void updateSessionName(result.agentName)
  }

  const initialState: AppState = {
    ...context.initialState,
    agentDefinitions: context.agentDefinitions,
    ...(agentType !== undefined ? { agent: agentType } : {}),
    ...(attributionState !== undefined ? { attribution: attributionState } : {}),
    ...(standaloneAgentContext !== undefined ? { standaloneAgentContext } : {}),
  }

  if (!opts.forkSession) {
    restoreMissionContinuity(result, updater => {
      updater(initialState)
    })
  }

  return {
    messages: result.messages,
    fileHistorySnapshots: result.fileHistorySnapshots ?? [],
    contentReplacements: result.contentReplacements ?? [],
    agentName: result.agentName,
    agentColor: (result.agentColor === DEFAULT_AGENT_COLOR ? undefined : result.agentColor) as
      | AgentColorName
      | undefined,
    restoredAgentDef: restoredAgentDefinition,
    initialState,
  }
}
