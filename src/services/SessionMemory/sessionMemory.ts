/**
 * Session memory: a background note-extraction hook that periodically writes
 * a structured markdown summary of the conversation, used to preserve
 * continuity across compaction and across sessions.
 *
 * The AUTOMATIC path has no failure handler by design: setup, prompt
 * building and the forked run are unguarded, so a throw escapes the hook with
 * the in-flight marker still set — the compaction waiter is bounded only by
 * its staleness/timeout rules. Do not wrap it in a finally; that changes what
 * the waiter sees.
 */
import { dirname } from 'node:path'

import { isAutoCompactEnabled } from '../compact/autoCompact.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { getErrnoCode } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { registerPostSamplingHook } from '../../utils/hooks/postSamplingHooks.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import { createUserMessage, hasToolCallsInLastAssistantTurn } from '../../utils/messages.js'
import type { Message } from '../../types/message.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { sequential } from '../../utils/sequential.js'
import { writeFileSync_DEPRECATED } from '../../utils/slowOperations.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import {
  createSubagentContext,
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { cloneFileStateCache } from '../../utils/fileStateCache.js'
import {
  getFeatureValue_CACHED_MAY_BE_STALE,
  getDynamicConfig_CACHED_MAY_BE_STALE,
} from '../analytics/featureGates.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FileReadTool } from '../../tools/FileReadTool/FileReadTool.js'
import {
  buildSessionMemoryUpdatePrompt,
  loadSessionMemoryTemplate,
} from './prompts.js'
import {
  getToolCallsBetweenUpdates,
  hasMetInitializationThreshold,
  hasMetUpdateThreshold,
  isSessionMemoryInitialized,
  markExtractionCompleted,
  markExtractionStarted,
  markSessionMemoryInitialized,
  recordExtractionTokenCount,
  setLastSummarizedMessageId,
  setSessionMemoryConfig,
} from './sessionMemoryUtils.js'

// ---------------------------------------------------------------------------
// Feature gate + one-time configuration
// ---------------------------------------------------------------------------

let configMaterialized = false

function isSessionMemoryGateOn(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE<boolean>('mercury_session_memory', false) === true
}

function materializeConfigOnce(): void {
  if (configMaterialized) return
  configMaterialized = true
  const remote = getDynamicConfig_CACHED_MAY_BE_STALE<Record<string, unknown>>('mercury_sm_config', {})
  const positive = (value: unknown): number | undefined =>
    typeof value === 'number' && value > 0 ? value : undefined
  const init = positive(remote.minimumMessageTokensToInit)
  const between = positive(remote.minimumTokensBetweenUpdate)
  const toolCalls = positive(remote.toolCallsBetweenUpdates)
  setSessionMemoryConfig({
    ...(init === undefined ? {} : { minimumMessageTokensToInit: init }),
    ...(between === undefined ? {} : { minimumTokensBetweenUpdate: between }),
    ...(toolCalls === undefined ? {} : { toolCallsBetweenUpdates: toolCalls }),
  })
}

// ---------------------------------------------------------------------------
// Trigger check
// ---------------------------------------------------------------------------

/**
 * The COUNTING anchor: the uuid of the last message at the previous positive
 * threshold check. Module-local and distinct from the utils-state
 * last-summarized id (which compaction consumes and which advances only after
 * a completed extraction — advancing it on mere triggers can orphan tool
 * results).
 */
let lastMemoryMessageUuid: string | undefined

function messageUuid(message: Message | undefined): string | undefined {
  return (message as { uuid?: string } | undefined)?.uuid
}

/** Count tool-use blocks from (exclusive of) the counting anchor; with no
 *  anchor the whole list counts. */
function countToolCallsSinceAnchor(messages: Message[]): number {
  const anchorUuid = lastMemoryMessageUuid
  let counting = anchorUuid === undefined
  let count = 0
  for (const message of messages) {
    if (!counting) {
      if (messageUuid(message) === anchorUuid) counting = true
      continue
    }
    if (message.type !== 'assistant') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    count += content.filter(block => (block as { type?: string }).type === 'tool_use').length
  }
  return count
}

/**
 * The threshold check. Side effect on EVERY positive result: the last
 * message's uuid becomes the new counting anchor. The token metric is the
 * shared estimation-capable counter auto-compact itself uses.
 */
export function shouldExtractMemory(messages: Message[]): boolean {
  const tokens = tokenCountWithEstimation(messages)

  // 1. Initialisation is latched once the init threshold is ever met.
  if (!isSessionMemoryInitialized()) {
    if (!hasMetInitializationThreshold(tokens)) return false
    markSessionMemoryInitialized()
  }

  // 2. The between-updates token threshold is ALWAYS required.
  if (!hasMetUpdateThreshold(tokens)) return false

  // 3. Either the tool-call threshold is met, or the last assistant turn has
  //    no tool calls (extraction at natural conversational breaks).
  const toolCalls = countToolCallsSinceAnchor(messages)
  const lastTurnHadTools = hasToolCallsInLastAssistantTurn(messages)
  if (toolCalls < getToolCallsBetweenUpdates() && lastTurnHadTools) return false

  const lastUuid = messageUuid(messages[messages.length - 1])
  if (lastUuid !== undefined) lastMemoryMessageUuid = lastUuid
  return true
}

// ---------------------------------------------------------------------------
// Notes file setup
// ---------------------------------------------------------------------------

/**
 * Create the notes file (exclusive, mode 0600, empty), then — only if that
 * creation succeeded — write the template. An "already exists" error is
 * expected and swallowed; any other error propagates. Returns the isolated
 * tool context whose read-file state holds the freshly read notes.
 */
async function setupNotesFile(parentContext: ToolUseContext): Promise<{
  notesPath: string
  currentNotes: string
  isolatedContext: ToolUseContext
}> {
  const notesPath = getSessionMemoryPath()
  getFsImplementation().mkdirSync(dirname(notesPath), { mode: 0o700 })
  try {
    writeFileSync_DEPRECATED(notesPath, '', { flag: 'wx', mode: 0o600 })
    const template = await loadSessionMemoryTemplate()
    writeFileSync_DEPRECATED(notesPath, template, { mode: 0o600 })
  } catch (error) {
    // ONLY the already-exists error is expected and swallowed; every other
    // setup error (permission and not-found classes included) propagates.
    if (getErrnoCode(error) !== 'EEXIST') throw error
  }

  // Isolated (forked) tool context so the parent's caches are not polluted.
  const isolatedContext = createSubagentContext(parentContext, {
    readFileState: cloneFileStateCache(parentContext.readFileState),
  })

  // Drop the read-file dedup entry so the read returns the text rather than
  // the unchanged-file placeholder; the read repopulates it.
  isolatedContext.readFileState.delete?.(notesPath)
  // The read is unguarded: a read-tool throw propagates out of setup. A text
  // result yields its content; any other result shape yields empty content.
  const output = await FileReadTool.call(
    { file_path: notesPath } as never,
    isolatedContext as never,
  )
  const data = (output as { data?: unknown }).data
  const text = (data as { file?: { content?: unknown } } | undefined)?.file?.content
  const currentNotes = typeof text === 'string' ? text : ''

  return { notesPath, currentNotes, isolatedContext }
}

// ---------------------------------------------------------------------------
// Permission function
// ---------------------------------------------------------------------------

/**
 * Restrict the forked agent to exactly one capability: the file-edit tool
 * applied to exactly the notes path. Every other tool and every other path
 * is denied. Path comparison is exact string equality.
 */
export function createMemoryFileCanUseTool(memoryPath: string): CanUseToolFn {
  const deny = () =>
    Promise.resolve({
      behavior: 'deny' as const,
      message: `session memory may only edit ${memoryPath} with the ${FILE_EDIT_TOOL_NAME} tool`,
      decisionReason: {
        type: 'other' as const,
        reason: `only editing ${memoryPath} is permitted during session-memory extraction`,
      },
    })
  return (async (tool, input) => {
    if ((tool as { name?: string }).name !== FILE_EDIT_TOOL_NAME) return deny()
    const path = (input as { file_path?: unknown }).file_path
    if (path !== memoryPath) return deny()
    return { behavior: 'allow' as const, updatedInput: input }
  }) as CanUseToolFn
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** The automatic hook — unguarded on purpose. */
async function runExtraction(context: REPLHookContext): Promise<void> {
  markExtractionStarted()
  const { notesPath, currentNotes, isolatedContext } = await setupNotesFile(
    context.toolUseContext,
  )
  const prompt = await buildSessionMemoryUpdatePrompt(currentNotes, notesPath)
  await runForkedAgent({
    promptMessages: [createUserMessage({ content: prompt })],
    cacheSafeParams: createCacheSafeParams(context),
    canUseTool: createMemoryFileCanUseTool(notesPath),
    querySource: 'session_memory',
    forkLabel: 'session_memory',
    // The isolated read-file state from setup, under the key the runner
    // recognises, so the forked agent's edit passes read-before-edit.
    overrides: { readFileState: isolatedContext.readFileState },
  })

  // New extraction baseline, then advance the utils-state last-summarized
  // id ONLY when the last assistant turn had no tool calls (a later
  // compaction could otherwise orphan tool results).
  recordExtractionTokenCount(tokenCountWithEstimation(context.messages))
  if (!hasToolCallsInLastAssistantTurn(context.messages)) {
    const lastUuid = messageUuid(context.messages[context.messages.length - 1])
    if (lastUuid !== undefined) setLastSummarizedMessageId(lastUuid)
  }
  markExtractionCompleted()
}

// ---------------------------------------------------------------------------
// Hook registration and serialisation
// ---------------------------------------------------------------------------

/**
 * The hook body, serialised with the shared `sequential()` wrapper so
 * overlapping invocations queue rather than interleave (or drop). It is
 * registered directly — no added catch wrapper: a throw escapes to the hook
 * registry by design.
 */
const sessionMemoryHook = sequential(async (context: REPLHookContext): Promise<void> => {
  // Guard order (each step costlier than the last): query source → gate →
  // one-time configuration → threshold → work.
  if (context.querySource !== 'repl_main_thread') return
  if (!isSessionMemoryGateOn()) return
  materializeConfigOnce()
  if (!shouldExtractMemory(context.messages)) return
  await runExtraction(context)
})

/**
 * Register the post-sampling hook. No-op in remote mode (session memory is
 * disabled entirely there) and only registered when auto-compact is enabled
 * (session memory exists to serve compaction).
 */
export function initSessionMemory(): void {
  if (getIsRemoteMode()) return
  if (!isAutoCompactEnabled()) return
  registerPostSamplingHook(sessionMemoryHook)
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/** Resets the COUNTING anchor (its contract), not the config latch. */
export function resetLastMemoryMessageUuid(): void {
  lastMemoryMessageUuid = undefined
}


export {
  buildSessionMemoryUpdatePrompt,
  DEFAULT_SESSION_MEMORY_TEMPLATE,
  isSessionMemoryEmpty,
  loadSessionMemoryPrompt,
  loadSessionMemoryTemplate,
  truncateSessionMemoryForCompact,
} from './prompts.js'
export {
  DEFAULT_SESSION_MEMORY_CONFIG,
  getSessionMemoryConfig,
  getToolCallsBetweenUpdates,
  hasMetInitializationThreshold,
  hasMetUpdateThreshold,
  isSessionMemoryInitialized,
  markExtractionCompleted,
  markExtractionStarted,
  markSessionMemoryInitialized,
  recordExtractionTokenCount,
  getLastSummarizedMessageId,
  setLastSummarizedMessageId,
  setSessionMemoryConfig,
  waitForSessionMemoryExtraction,
  resetSessionMemoryState,
  getSessionMemoryContent,
  type SessionMemoryConfig,
} from './sessionMemoryUtils.js'
