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

/**
 * Resume/continue/fork orchestration: state rehydration from a loaded
 * transcript, agent restoration, conversation-model retention, and
 * worktree re-entry.
 *
 * MULTI-AUTH LAW (this module serves every provider family): a restored
 * session's turns can come from any wire dialect the router speaks —
 * Anthropic Messages, OpenAI Responses, chat-completions carriers — so
 * nothing here may branch on the SPELLING of a model id, a family-specific
 * content-block kind, or a family-specific usage/stop field. Family
 * differences are the transport codecs' business; this module reads only
 * the canonical message shape (types/message.ts) and the factories' own
 * provenance markers (SYNTHETIC_MODEL).
 */

/**
 * The slice of a loaded conversation this module consumes. The transcript
 * loader's richer result is structurally assignable to it.
 */
export type ResumedConversationLog = {
  messages: Message[]
  sessionId?: string
  fileHistorySnapshots?: FileHistorySnapshot[]
  contentReplacements?: ContentReplacementRecord[]
  /** The team the transcript's session belonged to (recorded by the writer;
   *  drives the resumed-teammate context re-install). */
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

/** The sentinel agent colour meaning "no explicit colour". */
const DEFAULT_AGENT_COLOR = 'default'

/** An agent model declaration that defers to the session's model. */
const INHERIT_MODEL_SENTINEL = 'inherit'

/**
 * The most recent todo-write tool use wins, malformed or not: the walk
 * stops at the first (newest) matching assistant message and never falls
 * back to an older todo list. Within that message the LAST matching block
 * wins — every dialect's runtime can settle a parallel round as one
 * assistant message, and the newest write in the round is the standing
 * list. A non-object input or a validation failure yields an empty list.
 * Exported for the restore provers (scripts/run-recovery); the one
 * production consumer stays inside this module.
 */
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

/**
 * Applies state carried by the loaded transcript to application state:
 * file-history snapshots, and (when the file-backed task system is off)
 * the most recent in-conversation todo list.
 */
export function restoreSessionStateFromLog(
  result: ResumedConversationLog,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  if (result.fileHistorySnapshots && result.fileHistorySnapshots.length > 0) {
    fileHistoryRestoreStateFromLog(result.fileHistorySnapshots, state => {
      setAppState(prev => ({ ...prev, fileHistory: state }))
    })
  }

  // Interactive mode uses file-backed tasks, so the in-state todo list is
  // rehydrated only when that system is disabled.
  if (!isTodoV2Enabled() && result.messages.length > 0) {
    const todos = extractTodosFromMessages(result.messages)
    if (todos.length > 0) {
      const sessionId = getSessionId()
      setAppState(prev => ({ ...prev, todos: { ...prev.todos, [sessionId]: todos } }))
    }
  }

  // Resumed teammate identity: a transcript that recorded both a team and
  // an agent name re-installs the team context from the roster (the
  // reconnection module's contract — a missing roster member is only a
  // debug log; replLauncher's leader projection fills only when this and
  // the spawn-args path left teamContext unset).
  if (result.teamName && result.agentName) {
    initializeTeammateContextFromSession(setAppState, result.teamName, result.agentName)
  }

  // Mission continuity rides the shared helper below — the same seam the
  // boot-flag paths (processResumedConversation) use, so no resume path can
  // miss it.
  restoreMissionContinuity(result, setAppState)

  // Attribution restoration: inert in the build (see the computer below).
  // Context-collapse restoration: inert in the build.
  // Mode persistence on restore: inert in the build.
}

/**
 * The ONE mission-continuity applier every resume path shares: derive the
 * ADOPTED session's id from the loaded transcript itself (its top-level id,
 * else the first id-bearing message — the transcript is the identity
 * authority, not whatever id this process booted with), read the mission
 * card under that id, and arm under the LIVE id. Best-effort: resume never
 * fails on continuity.
 */
export function restoreMissionContinuity(
  result: Pick<ResumedConversationLog, 'messages' | 'sessionId'>,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): boolean {
  try {
    const fromMessages = result.messages.find(
      (m): m is Message & { sessionId: string } =>
        typeof (m as { sessionId?: unknown }).sessionId === 'string',
    ) as { sessionId?: string } | undefined
    const cardSessionId = result.sessionId ?? fromMessages?.sessionId ?? getSessionId()
    return rearmMissionFromCard(setAppState, { cardSessionId, armSessionId: getSessionId() })
  } catch (error) {
    logForDebugging(`resume: mission re-arm failed: ${String(error)}`)
    return false
  }
}

/**
 * The attribution-state computer for resume. The restoration path is not
 * wired in the build: this returns nothing, unconditionally.
 */
export function computeRestoredAttributionState(result: ResumedConversationLog): AttributionState | undefined {
  void result
  return undefined
}

/** Nothing when neither a name nor a colour was recorded; the default colour sentinel maps to no colour. */
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

/**
 * Restores the session's recorded agent, if it is still available.
 * A definition already chosen on the command line always wins.
 */
export function restoreAgentFromSession(
  agentSetting: string | undefined,
  currentAgentDefinition: AgentDefinition | undefined,
  agentDefinitions: AgentDefinitionsResult,
): { agentDefinition: AgentDefinition | undefined; agentType: string | undefined } {
  if (currentAgentDefinition) {
    return { agentDefinition: currentAgentDefinition, agentType: undefined }
  }
  if (agentSetting === undefined) {
    // No recorded agent: clear any stale stored main-thread agent type.
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


/**
 * Conversation-model retention (Mercury policy): a resumed conversation
 * continues on the model that was actually serving it, unless the operator
 * named a model for this boot. Pure — the caller applies the returned
 * SETTING through its own channel.
 *
 * Eligibility is PROVENANCE, never id spelling: the router serves every
 * provider family (first-party claude ids, OpenAI gpt/o-series ids,
 * slash-form carrier ids like openrouter/stealth/ox-alpha, gemini-, glm-,
 * kimi-, deepseek-, local ids …), so a gate keyed on how the id is spelled
 * silently drops whole families — the pre-rewrite claude-/gpt-/glm- filter
 * restored an OpenRouter-served session onto the default model. The one
 * non-dispatchable spelling is the factories' own SYNTHETIC_MODEL sentinel:
 * every locally-fabricated row (interrupts, API-error stand-ins, model-switch
 * breadcrumbs, resume sentinels) stamps it, and every row a transport codec
 * settles stamps the id the wire actually served. The row law and the
 * billing-safe form live in model/retainedModel — the daemon supervisor's
 * resume walk (resumeModelKeyOf) shares them, so every resume road answers
 * identically (prove-session-model-arms §6b pins the agreement).
 */
export function restoreConversationModelFromMessages(messages?: Message[]): string | null {
  if (!messages || messages.length === 0) return null
  // Command-line model, SDK set-model, and agent-declared models all set an
  // override before this runs; retention must never outrank them.
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

  // Billing-safe form law (retainedModel owns it): when the conversation
  // ran the current default's base id, return the default SETTING with any
  // context annotation intact, so a resumed session is posture-identical
  // to a fresh one. Otherwise the served id verbatim — never a suffix the
  // operator did not choose.
  return billingSafeRetainedForm(servedModel)
}

/** The cwd-sensitive caches a worktree transition must drop: instruction files, system-prompt sections, and the plans-directory memo. */
function invalidateWorktreeSensitiveCaches(): void {
  clearInstructionFileCaches()
  clearSystemPromptSectionState()
  getPlansDirectory.cache.clear()
}

/**
 * Re-enters the worktree the resumed session was inside, if any. The
 * directory change IS the existence probe: a separate check could pass and
 * the change still fail (the worktree can vanish between sessions), so
 * failure is handled where it happens and the cached record is overwritten
 * with none — otherwise exit-time metadata would carry the vanished path
 * forward.
 */
export function restoreWorktreeForResume(
  worktreeSession: PersistedWorktreeSession | null | undefined,
): void {
  // A worktree freshly created for THIS boot outranks the transcript's
  // record (metadata restoration just overwrote the cache with the stale
  // value): re-assert it and leave the recorded one alone.
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
  // The slash-command resume path runs mid-session with caches already
  // warm against the old directory; on the startup path these are cheap
  // no-ops. The project root is deliberately NOT set here: the transcript
  // does not record which entry route was taken, and the tool route (which
  // keeps project-scoped state on the original project) is the safe choice.
  invalidateWorktreeSensitiveCaches()
}

/**
 * Leaves the restored worktree before switching to another session
 * mid-flight. Without this, switching to a worktree-less session strands
 * the process inside the old worktree, and switching to a session with a
 * DIFFERENT worktree is blocked by the freshness guard above.
 */
export function exitRestoredWorktree(): void {
  const current = getCurrentWorktreeSession()
  if (current === null) return
  restoreWorktreeSession(null)
  saveWorktreeState(null)
  // Unconditional: the worktree state changed whether or not the directory
  // change below succeeds.
  invalidateWorktreeSensitiveCaches()
  try {
    process.chdir(current.originalCwd)
  } catch {
    // The original directory may itself be gone; stay put.
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

/**
 * The top-level entry for the continue and resume launch paths.
 * A non-forking restore adopts the loaded session (id, project directory, transcript
 * file, cost state); a fork keeps the fresh startup id and only seeds what
 * the normal recording path cannot reproduce.
 */
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
    /** Accepted, never read (kept for signature parity). */
    currentCwd: string
    /** Accepted, never read (kept for signature parity). */
    cliAgents: AgentDefinition[]
    initialState: AppState
  },
): Promise<ProcessedResume> {
  if (!opts.forkSession) {
    // A FULL log option carries no top-level sessionId (only lite logs do —
    // getSessionIdFromLog's own law), and the --resume <uuid> caller no
    // longer passes the CLI id as the override: adopting `undefined` here ran
    // the whole resumed REPL with getSessionId() === undefined — drafts never
    // persisted, the debug log landed in `undefined.txt`, hooks registered
    // "(session undefined)", owner keys threw on `.replace`. The first
    // message's id is the session's, the fallback the log helper uses.
    // The message scan takes the FIRST id-bearing row, not row [0] — a
    // transcript can open with a summary/meta row that carries no id, and
    // adopting undefined runs the documented no-identity failure class.
    const adoptedSessionId = (opts.sessionIdOverride ??
      result.sessionId ??
      (
        result.messages.find(
          m => typeof (m as { sessionId?: unknown }).sessionId === 'string',
        ) as { sessionId?: string } | undefined
      )?.sessionId) as SessionId
    // Switching sessions must also communicate the project directory: a
    // known transcript path is the authority (the session may live in a
    // different project, a worktree, or cross-project); otherwise the
    // session belongs to the current project.
    switchSession(adoptedSessionId, opts.transcriptPath ? dirname(opts.transcriptPath) : null)
    await renameRecordingForSession()
    // The pointer reset keeps the fresh-session file path from leaking
    // into the resumed session; adoption below re-establishes it.
    await resetSessionFilePointer()
    restoreCostStateForSession(adoptedSessionId)
  } else if (result.contentReplacements && result.contentReplacements.length > 0) {
    // A fork's messages are copied by the normal recording path, but
    // replacement records live in an entry kind only the replacement
    // recorder emits — seed them explicitly under the fresh session id.
    // Skipping this quietly disables prompt caching for the forked
    // conversation once it is itself resumed.
    await recordContentReplacement(result.contentReplacements)
  }

  // Restore metadata so status surfaces show the saved name and the exit
  // path re-appends it. A fork must NOT inherit the worktree record: the
  // worktree belongs to the original session, and a fork claiming it could
  // delete a directory the original still uses.
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
    // After metadata restoration (so a vanished directory can override the
    // cache) and before adoption (so the metadata written on adoption
    // reflects the worktree outcome).
    restoreWorktreeForResume(result.worktreeSession)
    // Re-establish the session-file pointer: the exit-time metadata append
    // refuses to run while it is null. A fork materialises lazily instead.
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
    // Exactly the definitions the caller passed in — no refresh here.
    agentDefinitions: context.agentDefinitions,
    ...(agentType !== undefined ? { agent: agentType } : {}),
    ...(attributionState !== undefined ? { attribution: attributionState } : {}),
    ...(standaloneAgentContext !== undefined ? { standaloneAgentContext } : {}),
  }

  if (!opts.forkSession) {
    // Mission continuity on the boot-flag paths (`--continue` /
    // `--resume <id>`): the re-arm lands in the RETURNED boot state itself —
    // addFunctionHook mutates the state it is handed, so the REPL mounts
    // with the Stop hook already armed. Same shared applier as
    // restoreSessionStateFromLog; a fork is a new session and inherits no
    // standing goal.
    restoreMissionContinuity(result, updater => {
      updater(initialState)
    })
  }

  return {
    messages: result.messages,
    fileHistorySnapshots: result.fileHistorySnapshots ?? [],
    contentReplacements: result.contentReplacements ?? [],
    agentName: result.agentName,
    // The log's colour string is a validated palette name.
    agentColor: (result.agentColor === DEFAULT_AGENT_COLOR ? undefined : result.agentColor) as
      | AgentColorName
      | undefined,
    restoredAgentDef: restoredAgentDefinition,
    initialState,
  }
}
