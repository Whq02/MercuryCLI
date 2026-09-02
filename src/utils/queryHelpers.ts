import { readFileSync } from 'node:fs'

import { getSessionId, isSessionPersistenceDisabled } from '../bootstrap/state.js'
import type { Tool as ToolType, Tools, ToolUseContext } from '../Tool.js'
import type {
  AssistantMessage,
  Message,
  NormalizedUserMessage,
  ProgressMessage,
  UserMessage,
} from '../types/message.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { OrphanedPermission } from '../types/textInputTypes.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB } from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import type { MCPProgress, ShellProgress } from '../types/tools.js'
import { isEphemeralToolProgress } from './sessionStorage/paths.js'
import { createFileStateCacheWithSizeLimit, type FileStateCache } from './fileStateCache.js'
import { getFileModificationTime, stripLineNumberPrefix } from './file.js'
import { logForDebugging } from './debug.js'
import { isENOENT } from './errors.js'
import { createUserMessage, isNotEmptyMessage, normalizeMessages } from './messages.js'
import { toolUseError } from '../services/tools/toolExecution.js'
import { isToolKilled, toolKillReason } from './permissions/capabilityGate.js'
import { expandPath } from './path.js'
import { recordTranscript, flushSessionStorage } from './sessionStorage.js'
import type { ProcessUserInputContext } from './processUserInput/processUserInput.js'

/**
 * Turn-success classification, message → SDK-event projection,
 * orphaned-permission replay, file-state extraction from history, and bash
 * CLI-name extraction.
 */

export type PermissionPromptTool = ToolType

// ---------------------------------------------------------------------------
// Turn success
// ---------------------------------------------------------------------------

/**
 * An assistant message whose LAST block is text/thinking/redacted-thinking;
 * a user message that is entirely tool results; otherwise only an
 * `end_turn` stop reason — the carve-out for a completed API turn with zero
 * assistant content (after a background agent's result the model may
 * legitimately end with nothing to add; classified as failure, that turn
 * would surface the whole accumulated error log as a false failure).
 */
export function isResultSuccessful(
  message: Message | undefined,
  stopReason?: string | null,
): message is AssistantMessage | UserMessage {
  if (message?.type === 'assistant') {
    const content = message.message.content
    if (Array.isArray(content) && content.length > 0) {
      const last = content[content.length - 1] as { type?: string }
      if (last.type === 'text' || last.type === 'thinking' || last.type === 'redacted_thinking') return true
    }
  }
  if (message?.type === 'user') {
    const content = message.message.content
    if (Array.isArray(content) && content.length > 0 && content.every(block => (block as { type?: string }).type === 'tool_result')) {
      return true
    }
  }
  return stopReason === 'end_turn'
}

// ---------------------------------------------------------------------------
// Message → SDK projection
// ---------------------------------------------------------------------------

// The SDK stdout projection: built as loose records internally, consumed
// as the SDK message union by the engine (cast at the yield boundary).
type SdkProjection = SDKMessage
type LooseProjection = Record<string, unknown>

const asProjection = (value: LooseProjection): SdkProjection => value as unknown as SdkProjection

// ── the ephemeral live tail (LIVEPAINT Layer 2, the runner's tap) ──────────
//
// Ephemeral tool progress (bash/powershell chunk output, mcp notifications)
// lives only in the runner process since the runner re-home — the transcript
// writer lawfully filters it from the file, so a daemon-hosted screen would
// never see a running tool's output. This projection is the missing mail
// road's FIRST HOP: one ADDITIVE `tool_progress` frame per beat per running
// tool on the runner's stream-json stdout, carrying the LATEST line only —
// never a backlog. The daemon's seat republishes it as a projection file and
// the screen's connector publishes it into the ephemeral progress store.
//
// MIXED-VERSION LAW (both directions): the SDK `tool_progress` frame type is
// open-schema and all-optional, so this build's frames are wire-legal to
// every consumer — an OLD daemon/screen simply has no arm for the type and
// ignores it (the glyph pulse still runs from the records fold); an OLD
// runner never emits it, and the new screen paints no tail (absence is a
// lawful state, never an error).
//
// SOURCE COALESCING: one frame per EPHEMERAL_TAIL_BEAT_MS per PARENT tool-use
// id (drop-throttle — the next beat's frame carries the then-latest line; the
// final line needs no trailing flush because the FULL output lands at settle
// exactly as today). The map is bounded, oldest evicted.
const EPHEMERAL_TAIL_BEAT_MS = 250
const EPHEMERAL_TAIL_MAP_CAP = 100
/** The wire bound for one latest-line payload (truncation-honest: a cut is
 *  marked). Screen-side width truncation happens at paint as ever. */
const EPHEMERAL_TAIL_LINE_MAX = 300

/** Keyed by the PARENT tool-use id (the child id changes per message). */
const ephemeralTailState = new Map<string, { lastEmitMs: number; seq: number }>()

/** The LAST non-blank line of a rolling output window, wire-bounded. */
function latestLineOf(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line === '') continue
    return line.length > EPHEMERAL_TAIL_LINE_MAX
      ? `${line.slice(0, EPHEMERAL_TAIL_LINE_MAX)}…`
      : line
  }
  return undefined
}

function userProjection(message: NormalizedUserMessage, parentToolUseId: string | null): LooseProjection {
  const mcpMeta = (message as { mcpMeta?: { _meta?: Record<string, unknown>; structuredContent?: unknown } }).mcpMeta
  const toolUseResult = (message as { toolUseResult?: unknown }).toolUseResult
  return {
    type: 'user',
    message: message.message,
    parent_tool_use_id: parentToolUseId,
    session_id: getSessionId(),
    uuid: message.uuid,
    timestamp: (message as { timestamp?: string }).timestamp,
    isSynthetic:
      (message as { isMeta?: boolean }).isMeta === true ||
      (message as { isVisibleInTranscriptOnly?: boolean }).isVisibleInTranscriptOnly === true,
    tool_use_result: mcpMeta ? { ...mcpMeta, content: toolUseResult } : toolUseResult,
  }
}

/** Zero or more SDK messages for one internal message. */
export function* normalizeMessage(message: Message): Generator<SdkProjection> {
  if (message.type === 'assistant') {
    for (const normalized of normalizeMessages([message])) {
      if (!isNotEmptyMessage(normalized as Message)) continue
      yield asProjection({
        type: 'assistant',
        message: normalized.message,
        parent_tool_use_id: null,
        session_id: getSessionId(),
        uuid: normalized.uuid,
        error: (normalized as { error?: unknown }).error,
      })
    }
    return
  }
  if (message.type === 'progress') {
    const progress = message as ProgressMessage
    const data = progress.data as { type?: string; message?: Message; taskId?: string; elapsedTimeSeconds?: number }
    if (data.type === 'agent_progress' || data.type === 'skill_progress') {
      const inner = data.message as Message
      for (const normalized of normalizeMessages([inner])) {
        if (normalized.type === 'assistant') {
          if (!isNotEmptyMessage(normalized as Message)) continue
          yield asProjection({
            type: 'assistant',
            message: normalized.message,
            parent_tool_use_id: progress.parentToolUseID,
            session_id: getSessionId(),
            uuid: normalized.uuid,
            error: (normalized as { error?: unknown }).error,
          })
        } else if (normalized.type === 'user') {
          yield asProjection(userProjection(normalized as NormalizedUserMessage, progress.parentToolUseID))
        }
      }
      return
    }
    if (isEphemeralToolProgress(data.type)) {
      // The ephemeral live tail (LIVEPAINT Layer 2 — see the block above):
      // one bounded latest-line frame per beat per parent tool call.
      const key = progress.parentToolUseID
      const now = Date.now()
      const state = ephemeralTailState.get(key)
      if (state !== undefined && now - state.lastEmitMs < EPHEMERAL_TAIL_BEAT_MS) return
      while (ephemeralTailState.size >= EPHEMERAL_TAIL_MAP_CAP) {
        const oldest = ephemeralTailState.keys().next()
        if (oldest.done) break
        ephemeralTailState.delete(oldest.value)
      }
      const seq = (state?.seq ?? 0) + 1
      ephemeralTailState.set(key, { lastEmitMs: now, seq })
      const shell = data as Partial<ShellProgress>
      const mcp = data as Partial<MCPProgress>
      const latestLine =
        data.type === 'mcp_progress'
          ? latestLineOf(mcp.progressMessage)
          : latestLineOf(shell.output)
      yield asProjection({
        type: 'tool_progress',
        tool_use_id: progress.toolUseID,
        parent_tool_use_id: progress.parentToolUseID,
        session_id: getSessionId(),
        uuid: progress.uuid,
        // Everything LIVEPAINT-specific rides the schema's own open payload
        // slot; the top level stays exactly the declared frame fields.
        progress: {
          kind: 'ephemeral_tail',
          data_type: data.type,
          seq,
          ...(typeof data.elapsedTimeSeconds === 'number'
            ? { elapsed_time_seconds: data.elapsedTimeSeconds }
            : {}),
          ...(latestLine !== undefined ? { latest_line: latestLine } : {}),
          ...(typeof shell.totalLines === 'number' && data.type !== 'mcp_progress'
            ? { total_lines: shell.totalLines }
            : {}),
          ...(typeof shell.totalBytes === 'number' && data.type !== 'mcp_progress'
            ? { total_bytes: shell.totalBytes }
            : {}),
          ...(data.type === 'mcp_progress' && typeof mcp.progress === 'number'
            ? { mcp_progress: mcp.progress }
            : {}),
          ...(data.type === 'mcp_progress' && typeof mcp.total === 'number'
            ? { mcp_total: mcp.total }
            : {}),
          // LIVENESS: the shell's own deadline budget rides the tick so the
          // focused chat's status row can name it beside the elapsed time.
          ...(typeof shell.budgetMs === 'number' && data.type !== 'mcp_progress'
            ? { budget_ms: shell.budgetMs }
            : {}),
        },
      })
      return
    }
    return
  }
  if (message.type === 'user') {
    for (const normalized of normalizeMessages([message])) {
      if (normalized.type !== 'user') continue
      yield asProjection(userProjection(normalized as NormalizedUserMessage, null))
    }
  }
}

// ---------------------------------------------------------------------------
// Orphaned-permission replay
// ---------------------------------------------------------------------------

/**
 * Completes a tool call whose permission decision arrived after the turn
 * ended. The history push is idempotent BY TOOL-USE ID — not message id: the
 * streaming layer records each content block as its own assistant entry
 * under a shared message id, and the unresolved-tool-use filter can remove
 * the tool-use entry while leaving a text sibling; a message-id check would
 * find the survivor, skip the push, and run the tool with no tool-use for
 * its result to attach to.
 */
export async function* handleOrphanedPermission(
  orphanedPermission: OrphanedPermission,
  tools: Tools,
  mutableMessages: Message[],
  processUserInputContext: ProcessUserInputContext,
): AsyncGenerator<SdkProjection> {
  const decision = orphanedPermission.permissionResult as {
    behavior?: string
    toolUseID?: string
    updatedInput?: Record<string, unknown>
  }
  const toolUseId = decision.toolUseID
  if (!toolUseId) return
  const assistantMessage = orphanedPermission.assistantMessage
  const content = assistantMessage.message.content
  const toolUseBlock = Array.isArray(content)
    ? (content.find(
        block => (block as { type?: string; id?: string }).type === 'tool_use' && (block as { id?: string }).id === toolUseId,
      ) as { id: string; name: string; input: Record<string, unknown> } | undefined)
    : undefined
  if (!toolUseBlock) return
  const tool = tools.find(candidate => candidate.name === toolUseBlock.name)
  if (!tool) return

  let input = toolUseBlock.input
  if (decision.behavior === 'allow') {
    if (decision.updatedInput) {
      input = decision.updatedInput
    } else {
      logForDebugging(
        `WARNING: orphaned permission for ${toolUseBlock.name} carried no updated input; using the original input`,
      )
    }
  }

  const alreadyPushed = mutableMessages.some(
    message =>
      message.type === 'assistant' &&
      Array.isArray(message.message.content) &&
      message.message.content.some(
        block => (block as { type?: string; id?: string }).type === 'tool_use' && (block as { id?: string }).id === toolUseId,
      ),
  )
  if (!alreadyPushed) {
    mutableMessages.push(assistantMessage)
    if (!isSessionPersistenceDisabled()) {
      void recordTranscript([assistantMessage])
      void flushSessionStorage()
    }
  }
  yield asProjection({
    type: 'assistant',
    message: assistantMessage.message,
    parent_tool_use_id: null,
    session_id: getSessionId(),
    uuid: assistantMessage.uuid,
  })

  // Settle the dangling tool_use as a typed, rendered failure — the shared
  // shape for every refusal and validation arm below (law 1: the transcript
  // says what happened; the tool_use never dangles into the next resume).
  const settleAsError = (text: string): Message => {
    const errorMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          content: toolUseError(text),
          is_error: true,
          tool_use_id: toolUseId,
        },
      ] as never,
      toolUseResult: text,
      sourceToolAssistantUUID: assistantMessage.uuid as never,
    })
    mutableMessages.push(errorMessage)
    if (!isSessionPersistenceDisabled()) {
      void recordTranscript([errorMessage])
      void flushSessionStorage()
    }
    return errorMessage
  }

  // THE VERDICT GATE (sweep #2 security rider, sweep-4 DF-101 fault
  // 2): a late answer only RUNS the tool when it says allow. The admission
  // seam accepts any well-shaped control_response so the dangling tool_use
  // can settle; the verdict decides HERE, before any permission function
  // exists — a deny, an unanswered ask, or a junk behavior ends the replay
  // as a rendered refusal and the tool body is never reached (law 3: the
  // operator's no is a no).
  if (decision.behavior !== 'allow') {
    const saidNo = decision.behavior === 'deny'
    const reason = (orphanedPermission.permissionResult as { message?: string }).message
    const text = saidNo
      ? `Permission denied${reason ? `: ${reason}` : ''} — the late answer refused ${toolUseBlock.name}; the tool did not run.`
      : `Permission was never granted (the late answer carried ${JSON.stringify(decision.behavior ?? 'no verdict')}) — ${toolUseBlock.name} did not run.`
    logForDebugging(
      `handleOrphanedPermission: non-allow verdict for ${toolUseBlock.name} (${String(decision.behavior)}) — settled as a refusal, tool not invoked`,
    )
    yield* normalizeMessage(settleAsError(text))
    return
  }

  // The kill switch is re-consulted at REPLAY time: an answer minted before
  // the operator killed the capability must not outrank the kill.
  const replayAgentType = (processUserInputContext as { agentType?: string }).agentType
  if (isToolKilled(tool, replayAgentType)) {
    const kill = toolKillReason(tool, replayAgentType)
    const text = `${toolUseBlock.name} is disabled by the operator's kill switch${kill ? ` (${kill.killPattern})` : ''} — the approved call was not run.`
    logForDebugging(`handleOrphanedPermission: ${toolUseBlock.name} killed at replay time — settled as a refusal`)
    yield* normalizeMessage(settleAsError(text))
    return
  }

  // Replay bypasses the executor's boundary gate, so it validates the
  // persisted (or permission-updated) input itself: a malformed call from
  // an old transcript settles as an error result — it never reaches the
  // tool body and never leaves the tool_use dangling on resume.
  const parsedReplayInput = tool.inputSchema.safeParse(input)
  if (!parsedReplayInput.success) {
    yield* normalizeMessage(settleAsError(`InputValidationError: ${parsedReplayInput.error.message}`))
    return
  }

  const permissionFn = async (): Promise<unknown> => ({
    ...orphanedPermission.permissionResult,
    decisionReason: { type: 'mode', mode: 'default' },
  })
  const updates = tool.call(parsedReplayInput.data as never, processUserInputContext as unknown as ToolUseContext, permissionFn as never, assistantMessage as never)
  for await (const update of updates as unknown as AsyncGenerator<{ message?: Message }>) {
    const updateMessage = (update as { message?: Message }).message ?? (update as unknown as Message)
    if (!updateMessage || typeof updateMessage !== 'object' || !('type' in updateMessage)) continue
    mutableMessages.push(updateMessage)
    if (!isSessionPersistenceDisabled()) {
      void recordTranscript([updateMessage])
      void flushSessionStorage()
    }
    yield* normalizeMessage(updateMessage)
  }
}

// ---------------------------------------------------------------------------
// File-state extraction from history
// ---------------------------------------------------------------------------

const DEFAULT_EXTRACT_CACHE_SIZE = 10
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g

type ToolUseRecord = { path: string; content?: string }

/**
 * Rebuilds a file-state cache from history so a resumed session knows what
 * the model has already read. Runs once at startup over an existing
 * history, which is why the edit branch may read disk (disk holds the state
 * after all recorded edits) — and each edit processes in order, so
 * last-writer-wins holds across interleaved reads/writes/edits.
 */
export function extractReadFilesFromMessages(
  messages: Message[],
  cwd: string,
  maxSize: number = DEFAULT_EXTRACT_CACHE_SIZE,
): FileStateCache {
  const cache = createFileStateCacheWithSizeLimit(maxSize)
  const reads = new Map<string, ToolUseRecord>()
  const writes = new Map<string, ToolUseRecord>()
  const edits = new Map<string, ToolUseRecord>()

  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const toolUse = block as { type?: string; id?: string; name?: string; input?: Record<string, unknown> }
      if (toolUse.type !== 'tool_use' || !toolUse.id || !toolUse.input) continue
      const filePath = toolUse.input.file_path
      if (typeof filePath !== 'string' || filePath === '') continue
      const absolute = expandPath(filePath, cwd)
      if (toolUse.name === FILE_READ_TOOL_NAME) {
        // Ranged reads are not cached.
        if (toolUse.input.offset === undefined && toolUse.input.limit === undefined) {
          reads.set(toolUse.id, { path: absolute })
        }
      } else if (toolUse.name === FILE_WRITE_TOOL_NAME) {
        const written = toolUse.input.content
        if (typeof written === 'string' && written !== '') {
          writes.set(toolUse.id, { path: absolute, content: written })
        }
      } else if (toolUse.name === FILE_EDIT_TOOL_NAME) {
        edits.set(toolUse.id, { path: absolute })
      }
    }
  }

  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    const timestamp = (message as { timestamp?: string }).timestamp
    for (const block of content) {
      const result = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
      if (result.type !== 'tool_result' || !result.tool_use_id) continue
      const read = reads.get(result.tool_use_id)
      if (read) {
        if (typeof result.content !== 'string') continue
        // The unchanged-file stub carries none of the file; letting it
        // through would overwrite the genuine content from the first read.
        if (result.content.startsWith(FILE_UNCHANGED_STUB)) continue
        if (!timestamp) continue
        const cleaned = result.content
          .replace(SYSTEM_REMINDER_PATTERN, '')
          .split('\n')
          .map(line => stripLineNumberPrefix(line))
          .join('\n')
          .trim()
        cache.set(read.path, { content: cleaned, timestamp: Date.parse(timestamp), offset: undefined, limit: undefined })
        continue
      }
      const write = writes.get(result.tool_use_id)
      if (write && write.content !== undefined) {
        if (!timestamp) continue
        cache.set(write.path, { content: write.content, timestamp: Date.parse(timestamp), offset: undefined, limit: undefined })
        continue
      }
      const edit = edits.get(result.tool_use_id)
      if (edit && result.is_error !== true) {
        try {
          const diskContent = readFileSync(edit.path, 'utf8')
          // The REAL modification time: a synthetic one would make every
          // edited file look modified to the next turn's changed-file check.
          const mtime = getFileModificationTime(edit.path)
          cache.set(edit.path, { content: diskContent, timestamp: mtime, offset: undefined, limit: undefined })
        } catch (err) {
          if (!isENOENT(err) && !(err instanceof Error && (err as NodeJS.ErrnoException).code === 'EACCES')) throw err
        }
      }
    }
  }
  return cache
}

// ---------------------------------------------------------------------------
// Bash CLI-name extraction
// ---------------------------------------------------------------------------

const PREFIX_COMMANDS = new Set(['sudo'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Top-level command names across bash tool uses, deduplicated; env assignments and prefix commands skipped. */
export function extractBashToolsFromMessages(messages: Message[]): Set<string> {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const toolUse = block as { type?: string; name?: string; input?: { command?: unknown } }
      if (toolUse.type !== 'tool_use' || toolUse.name !== BASH_TOOL_NAME) continue
      const command = toolUse.input?.command
      if (typeof command !== 'string' || command.trim() === '') continue
      const tokens = command.trim().split(/\s+/)
      let index = 0
      while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index] as string)) index++
      while (index < tokens.length && PREFIX_COMMANDS.has(tokens[index] as string)) index++
      const name = tokens[index]
      if (name) names.add(name)
    }
  }
  return names
}
