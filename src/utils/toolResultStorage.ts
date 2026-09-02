import { mkdir, writeFile } from 'node:fs/promises'
import { sliceHeadAtGrapheme, sliceTailAtGrapheme } from './intl.js'
import { join } from 'node:path'

import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import type { Tool } from '../Tool.js'
import type { Message } from '../types/message.js'
import type { ToolResultBlockParam } from '../types/wire.js'
import { DEFAULT_MAX_RESULT_SIZE_CHARS, MAX_TOOL_RESULTS_PER_MESSAGE_CHARS } from '../constants/toolLimits.js'
import { logForDebugging } from './debug.js'
import { errorMessage, getErrnoCode, getErrnoPath } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'
import { getProjectDir } from './sessionStorage/paths.js'

/**
 * Persists oversized tool results to disk (with a head+tail preview) and
 * enforces a per-message aggregate budget whose decisions never change for
 * the life of the conversation — the permanence is what keeps the
 * prompt-cache prefix stable.
 */

/** On-disk contract: the subdirectory under the session directory. */
export const TOOL_RESULTS_SUBDIR = 'tool-results'
/** Matched by other code with a PREFIX test — exact strings are contract. */
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'
/** Micro-compaction's substitution sentinel; also matched exactly. */
export const TOOL_RESULT_CLEARED_MESSAGE = '[stale tool result pruned — content cleared]'
/** The pre-migration sentinel spelling — accepted on read forever (persisted transcripts carry it), never emitted. */
export const LEGACY_TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]'

/** The preview budget is measured in STRING units — the clamper slices JavaScript strings, so the label says characters, never bytes. */
export const PREVIEW_SIZE_CHARS = 2000
/** @deprecated Older importers use this alias of {@link PREVIEW_SIZE_CHARS}. */
export const PREVIEW_SIZE_BYTES = PREVIEW_SIZE_CHARS
export const PREVIEW_MAX_LINE_CHARS = 400

export type PersistedToolResult = {
  filepath: string
  /** UTF-8 bytes (the on-disk file size), never a code-unit count. */
  originalSize: number
  isJson: boolean
  preview: string
  hasMore: boolean
}

export type PersistToolResultError = { error: string }

export function isPersistError(
  result: PersistedToolResult | PersistToolResultError,
): result is PersistToolResultError {
  return 'error' in result
}

/** The transcript entry payload; `kind` discriminates future replacement mechanisms sharing the entry type. */
export type ToolResultReplacementRecord = {
  kind: 'tool-result'
  toolUseId: string
  replacement: string
}

export type ContentReplacementRecord = ToolResultReplacementRecord

export type ContentReplacementState = {
  /** Every tool-use id the budget has decided about (replace OR leave alone). */
  seenIds: Set<string>
  /** The exact replacement string shown to the model, by tool-use id. */
  replacements: Map<string, string>
}

/**
 * A non-finite declared cap is a hard opt-out that PRECEDES the override —
 * the file-read tool bounds itself by its own token cap, and writing its
 * output to a file the model reads back with that same tool is circular. A
 * gate override wins outright (that is how the flag raises a cap); the
 * gate cache can hand back null or garbage, so the lookup is guarded.
 */
export function getPersistenceThreshold(toolName: string, declaredMaxResultSizeChars: number): number {
  if (!Number.isFinite(declaredMaxResultSizeChars)) return declaredMaxResultSizeChars
  let overrides: Record<string, unknown> | null = null
  try {
    overrides = getFeatureValue_CACHED_MAY_BE_STALE<Record<string, unknown> | null>('mercury_satin_quoll', {})
  } catch {
    overrides = null
  }
  const entry = overrides?.[toolName]
  if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) return entry
  return Math.min(declaredMaxResultSizeChars, DEFAULT_MAX_RESULT_SIZE_CHARS)
}

export function getToolResultsDir(): string {
  return join(getProjectDir(getOriginalCwd()), getSessionId(), TOOL_RESULTS_SUBDIR)
}

export function getToolResultPath(id: string, isJson: boolean): string {
  return join(getToolResultsDir(), `${id}${isJson ? '.json' : '.txt'}`)
}

export async function ensureToolResultsDir(): Promise<void> {
  try {
    await mkdir(getToolResultsDir(), { recursive: true })
  } catch {
    // The usual cause is that it already exists.
  }
}

function describeFsError(error: unknown): string {
  const code = getErrnoCode(error)
  if (code === null || code === undefined) return errorMessage(error)
  const path = getErrnoPath(error) ?? 'an unknown path'
  switch (code) {
    case 'ENOENT':
      return `Directory not found: ${path}`
    case 'EACCES':
    case 'EPERM':
      return `Permission denied: ${path}`
    case 'ENOSPC':
      return 'No space left on device'
    case 'EROFS':
      return `Read-only file system: ${path}`
    case 'EMFILE':
    case 'ENFILE':
      return 'Too many open files'
    case 'EEXIST':
      return `File already exists: ${path}`
    default:
      return `${code}: ${errorMessage(error)}`
  }
}

/**
 * Long lines are clamped so a single line of base64 or a minified file
 * cannot consume the whole preview budget and return nothing useful.
 */
function clampLine(line: string): string {
  if (line.length <= PREVIEW_MAX_LINE_CHARS) return line
  return `${sliceHeadAtGrapheme(line, PREVIEW_MAX_LINE_CHARS)} …[line clamped: ${line.length} chars]`
}

function clampLines(text: string): string {
  return text.split('\n').map(clampLine).join('\n')
}

/**
 * Head AND tail: exit status, summary lines and "did the final command
 * actually run" all live at the end of an output, and a head-only preview
 * cost the model extra round trips to recover them. Within-budget content
 * reports no omission even when individual lines were clamped — clamping
 * shortens lines and names each clamp, so nothing was cut.
 */
export function generatePreview(content: string, maxBytes: number): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: clampLines(content), hasMore: false }
  }
  const headBudget = Math.floor(maxBytes * 0.6)
  const tailBudget = maxBytes - headBudget
  let head = sliceHeadAtGrapheme(content, headBudget)
  const headNewline = head.lastIndexOf('\n')
  if (headNewline > headBudget / 2) head = head.slice(0, headNewline)
  let tail = sliceTailAtGrapheme(content, tailBudget)
  const tailNewline = tail.indexOf('\n')
  if (tailNewline !== -1 && tailNewline < tailBudget / 2) tail = tail.slice(tailNewline + 1)
  const skipped = Math.max(0, content.length - head.length - tail.length)
  const preview = `${clampLines(head)}\n… [${formatFileSize(skipped)} skipped — full output persisted] …\n${clampLines(tail)}`
  return { preview, hasMore: true }
}

type TextBlockLike = { type?: string; text?: string }

/**
 * Persists one result with an EXCLUSIVE create rather than stat-then-write.
 * An already-exists error is not a failure: the tool-use id is unique per
 * invocation and its content deterministic, so an existing file means an
 * earlier turn wrote exactly these bytes (micro-compaction replays).
 */
export async function persistToolResult(
  content: string | TextBlockLike[],
  toolUseId: string,
): Promise<PersistedToolResult | PersistToolResultError> {
  const isJson = Array.isArray(content)
  if (isJson && (content as TextBlockLike[]).some(block => block.type !== 'text')) {
    return { error: 'Tool results containing non-text content cannot be persisted' }
  }
  await ensureToolResultsDir()
  const filePath = getToolResultPath(toolUseId, isJson)
  const serialized = isJson ? JSON.stringify(content, null, 2) : (content as string)
  const sizeBytes = Buffer.byteLength(serialized, 'utf8')
  try {
    await writeFile(filePath, serialized, { flag: 'wx' })
    logForDebugging(`tool result persisted: ${filePath} (${formatFileSize(sizeBytes)})`)
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') {
      logError(error)
      return { error: describeFsError(error) }
    }
  }
  const { preview, hasMore } = generatePreview(serialized, PREVIEW_SIZE_CHARS)
  return { filepath: filePath, originalSize: sizeBytes, isJson, preview, hasMore }
}

/** The reference message substituted for an oversized result. The opening tag is prefix-matched by other code. */
export function buildLargeToolResultMessage(result: PersistedToolResult): string {
  return (
    `${PERSISTED_OUTPUT_TAG}\n` +
    `Output too large (${formatFileSize(result.originalSize)}). Full output saved to: ${result.filepath}\n\n` +
    `Preview (head + tail, ~${PREVIEW_SIZE_CHARS} chars; long lines clamped):\n` +
    `${result.preview}\n` +
    PERSISTED_OUTPUT_CLOSING_TAG
  )
}

/**
 * Empty means: absent, whitespace-only string, empty array, or all-text
 * blocks with blank text. Non-text blocks (images, tool references) and
 * non-array/non-string content count as non-empty. Empty results at the
 * prompt tail led some models to emit their stop sequence and end the
 * turn, so the model must always be given something to react to.
 */
export function isToolResultContentEmpty(content: unknown): boolean {
  if (content === undefined || content === null) return true
  if (typeof content === 'string') return content.trim() === ''
  if (Array.isArray(content)) {
    if (content.length === 0) return true
    return (content as TextBlockLike[]).every(
      block => block.type === 'text' && (typeof block.text !== 'string' || block.text.trim() === ''),
    )
  }
  return false
}

/** Rough size: string length, or the sum of text-block lengths (the JSON framing is omitted deliberately — this is a token heuristic, not an exact measure). */
function contentSizeOf(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return (content as TextBlockLike[]).reduce(
    (sum, block) => sum + (block.type === 'text' && typeof block.text === 'string' ? block.text.length : 0),
    0,
  )
}

function hasImageBlock(content: unknown): boolean {
  return Array.isArray(content) && (content as TextBlockLike[]).some(block => block.type === 'image')
}

async function applySizePersistence(
  block: ToolResultBlockParam,
  toolName: string,
  threshold: number | undefined,
): Promise<ToolResultBlockParam> {
  const content = (block as { content?: unknown }).content
  if (isToolResultContentEmpty(content)) {
    return { ...block, content: `(The ${toolName} tool completed successfully with no output)` }
  }
  // Images must reach the model as-is.
  if (hasImageBlock(content)) return block
  // A PREFIX test, never containment: content that merely MENTIONS the tag
  // (a read of the file defining it) must not be misclassified.
  if (typeof content === 'string' && content.startsWith(PERSISTED_OUTPUT_TAG)) return block
  const limit = threshold ?? DEFAULT_MAX_RESULT_SIZE_CHARS
  if (contentSizeOf(content) <= limit) return block
  const persisted = await persistToolResult(content as string | TextBlockLike[], block.tool_use_id)
  if (isPersistError(persisted)) return block
  return { ...block, content: buildLargeToolResultMessage(persisted) }
}

/** Maps a tool result through the tool's own mapper, then applies size-based persistence. */
export async function processToolResultBlock<T>(
  tool: Tool,
  toolUseResult: T,
  toolUseID: string,
): Promise<ToolResultBlockParam> {
  const block = (
    tool as unknown as {
      mapToolResultToToolResultBlockParam: (result: T, id: string) => ToolResultBlockParam
    }
  ).mapToolResultToToolResultBlockParam(toolUseResult, toolUseID)
  const threshold = getPersistenceThreshold(tool.name, (tool as { maxResultSizeChars?: number }).maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS)
  return applySizePersistence(block, tool.name, threshold)
}

/** The pre-mapped variant of {@link processToolResultBlock}. */
export async function processPreMappedToolResultBlock(
  block: ToolResultBlockParam,
  toolName: string,
  maxResultSizeChars: number,
): Promise<ToolResultBlockParam> {
  return applySizePersistence(block, toolName, getPersistenceThreshold(toolName, maxResultSizeChars))
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() }
}

/** A deep-enough clone: mutating the clone cannot affect the source, so cache-sharing forks make identical decisions safely. */
export function cloneContentReplacementState(source: ContentReplacementState): ContentReplacementState {
  return { seenIds: new Set(source.seenIds), replacements: new Map(source.replacements) }
}

/** The per-message limit; the gate wins when positive and finite, resolved once per enforcement call. */
export function getPerMessageBudgetLimit(): number {
  try {
    const fromGate = getFeatureValue_CACHED_MAY_BE_STALE<number | null>('mercury_hawthorn_window', null)
    if (typeof fromGate === 'number' && Number.isFinite(fromGate) && fromGate > 0) return fromGate
  } catch {
    // Fall through to the constant.
  }
  return MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
}

/**
 * Gate-controlled provisioning: off means no state at all (the query loop
 * then skips enforcement entirely); a cold start gets a fresh state; a
 * resume reconstructs from the loaded messages and transcript records.
 */
export function provisionContentReplacementState(
  initialMessages?: Message[],
  initialContentReplacements?: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  let enabled = false
  try {
    enabled = getFeatureValue_CACHED_MAY_BE_STALE<boolean>('mercury_hawthorn_steeple', false) === true
  } catch {
    enabled = false
  }
  if (!enabled) return undefined
  if (!initialMessages || initialMessages.length === 0) return createContentReplacementState()
  return reconstructContentReplacementState(initialMessages, initialContentReplacements ?? [])
}

type BudgetCandidate = {
  toolUseId: string
  content: unknown
  size: number
}

/** A candidate: a tool-result block with content, not compacted, no image. */
function collectCandidates(message: Message): BudgetCandidate[] {
  if (message.type !== 'user') return []
  const content = message.message.content
  if (!Array.isArray(content)) return []
  const candidates: BudgetCandidate[] = []
  for (const block of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
    if (block.type !== 'tool_result') continue
    if (typeof block.tool_use_id !== 'string') continue
    if (block.content === undefined || block.content === null) continue
    if (typeof block.content === 'string' && (block.content.startsWith(TOOL_RESULT_CLEARED_MESSAGE) || block.content.startsWith(LEGACY_TOOL_RESULT_CLEARED_MESSAGE))) continue
    if (hasImageBlock(block.content)) continue
    candidates.push({ toolUseId: block.tool_use_id, content: block.content, size: contentSizeOf(block.content) })
  }
  return candidates
}

/**
 * Budget enforcement over WIRE-LEVEL user messages: consecutive stored
 * user messages form one group until an assistant message whose response
 * id is seen for the FIRST time intervenes — the API normalisation merges
 * consecutive user messages, so parallel tool results stored as N messages
 * arrive as one over-budget wire message. Progress, attachment and
 * system-command messages never split a group, and a repeated response id
 * (streamed blocks, interleaved coordinator responses) must not either.
 * MUTATES `state`.
 */
export async function enforceToolResultBudget(
  messages: Message[],
  state: ContentReplacementState,
  skipToolNames: ReadonlySet<string> = new Set(),
): Promise<{ messages: Message[]; replacements: ToolResultReplacementRecord[] }> {
  const limit = getPerMessageBudgetLimit()

  // Grouping by first-seen assistant response ids.
  const groups: BudgetCandidate[][] = []
  let currentGroup: BudgetCandidate[] = []
  const seenResponseIds = new Set<string>()
  for (const message of messages) {
    if (message.type === 'assistant') {
      const responseId = (message as { message?: { id?: string } }).message?.id
      if (responseId && !seenResponseIds.has(responseId)) {
        seenResponseIds.add(responseId)
        if (currentGroup.length > 0) {
          groups.push(currentGroup)
          currentGroup = []
        }
      }
      continue
    }
    if (message.type !== 'user') continue
    currentGroup.push(...collectCandidates(message))
  }
  if (currentGroup.length > 0) groups.push(currentGroup)

  // The tool-name map is built only when a skip list was actually supplied.
  let toolNamesById: Map<string, string> | null = null
  if (skipToolNames.size > 0) {
    toolNamesById = new Map()
    for (const message of messages) {
      if (message.type !== 'assistant') continue
      const content = message.message.content
      if (!Array.isArray(content)) continue
      for (const block of content as Array<{ type?: string; id?: string; name?: string }>) {
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          toolNamesById.set(block.id, block.name)
        }
      }
    }
  }

  const applyById = new Map<string, string>()
  const newReplacements: ToolResultReplacementRecord[] = []
  let reappliedCount = 0
  let overBudgetGroups = 0
  let shedSize = 0

  for (const group of groups) {
    const freshCandidates: BudgetCandidate[] = []
    let frozenSize = 0
    for (const candidate of group) {
      const priorReplacement = state.replacements.get(candidate.toolUseId)
      if (priorReplacement !== undefined) {
        // Re-applying is a map lookup: no I/O, identical bytes, cannot fail.
        applyById.set(candidate.toolUseId, priorReplacement)
        reappliedCount++
        continue
      }
      if (state.seenIds.has(candidate.toolUseId)) {
        // Frozen: replacing now would change a prefix the model already saw.
        frozenSize += candidate.size
        continue
      }
      freshCandidates.push(candidate)
    }
    if (freshCandidates.length === 0) {
      for (const candidate of group) state.seenIds.add(candidate.toolUseId)
      continue
    }

    // Skipped tools freeze on first sight and do not count toward the
    // fresh size; the skipped tool's own cap is the bound.
    let eligibleFresh = freshCandidates
    if (toolNamesById !== null) {
      eligibleFresh = []
      for (const candidate of freshCandidates) {
        const toolName = toolNamesById.get(candidate.toolUseId)
        if (toolName !== undefined && skipToolNames.has(toolName)) {
          state.seenIds.add(candidate.toolUseId)
        } else {
          eligibleFresh.push(candidate)
        }
      }
    }

    const freshSize = eligibleFresh.reduce((sum, candidate) => sum + candidate.size, 0)
    if (frozenSize + freshSize <= limit) {
      // Under budget: the leave-alone decision is taken and sticks.
      for (const candidate of group) state.seenIds.add(candidate.toolUseId)
      continue
    }
    overBudgetGroups++

    // Largest-first selection until the remainder fits (or the list runs
    // out — frozen results alone may exceed the budget, and that overage
    // is accepted; micro-compaction clears them in time). Subtracting the
    // full size is an approximation: the replacement's real size is only
    // known after persistence, and previews are small beside anything
    // reaching this path.
    const sortedFresh = [...eligibleFresh].sort((a, b) => b.size - a.size)
    let remainder = frozenSize + freshSize
    const selected: BudgetCandidate[] = []
    for (const candidate of sortedFresh) {
      if (remainder <= limit) break
      selected.push(candidate)
      remainder -= candidate.size
    }
    const selectedIds = new Set(selected.map(candidate => candidate.toolUseId))

    // Non-selected candidates are marked seen SYNCHRONOUSLY; selected ones
    // only after the await, in the same step that records the replacement —
    // an observer finding an id seen but not replaced classifies it as
    // frozen, and two threads would then send different bytes.
    for (const candidate of group) {
      if (!selectedIds.has(candidate.toolUseId)) state.seenIds.add(candidate.toolUseId)
    }
    for (const candidate of selected) {
      const persisted = await persistToolResult(
        candidate.content as string | TextBlockLike[],
        candidate.toolUseId,
      )
      if (isPersistError(persisted)) {
        // The original content went to the model; frozen from now on.
        state.seenIds.add(candidate.toolUseId)
        continue
      }
      const replacement = buildLargeToolResultMessage(persisted)
      state.seenIds.add(candidate.toolUseId)
      state.replacements.set(candidate.toolUseId, replacement)
      applyById.set(candidate.toolUseId, replacement)
      newReplacements.push({ kind: 'tool-result', toolUseId: candidate.toolUseId, replacement })
      shedSize += candidate.size
    }
  }

  // Identity matters to callers: nothing applied ⇒ the same array instance.
  if (applyById.size === 0) {
    return { messages, replacements: [] }
  }

  const rebuilt = messages.map(message => {
    if (message.type !== 'user') return message
    const content = message.message.content
    if (!Array.isArray(content)) return message
    const affected = (content as Array<{ type?: string; tool_use_id?: string }>).some(
      block => block.type === 'tool_result' && typeof block.tool_use_id === 'string' && applyById.has(block.tool_use_id),
    )
    if (!affected) return message
    return {
      ...message,
      message: {
        ...message.message,
        content: (content as Array<{ type?: string; tool_use_id?: string }>).map(block =>
          block.type === 'tool_result' && typeof block.tool_use_id === 'string' && applyById.has(block.tool_use_id)
            ? { ...block, content: applyById.get(block.tool_use_id) }
            : block,
        ),
      },
    } as Message
  })

  if (newReplacements.length > 0) {
    logForDebugging(
      `tool-result budget: persisted ${newReplacements.length} results across ${overBudgetGroups} over-budget messages (~${shedSize} chars shed, ${reappliedCount} re-applied)`,
    )
  }
  return { messages: rebuilt, replacements: newReplacements }
}

/**
 * The query-loop wrapper: no state means the feature is off and the
 * messages pass through untouched. The transcript callback is supplied
 * only by query sources whose records are read back on resume.
 */
export async function applyToolResultBudget(
  messages: Message[],
  state: ContentReplacementState | undefined,
  writeToTranscript?: (records: ToolResultReplacementRecord[]) => void | Promise<void>,
  skipToolNames?: ReadonlySet<string>,
): Promise<Message[]> {
  if (!state) return messages
  const result = await enforceToolResultBudget(messages, state, skipToolNames ?? new Set())
  if (writeToTranscript && result.replacements.length > 0) {
    await writeToTranscript(result.replacements)
  }
  return result.messages
}

/**
 * Resume reconstruction. Every candidate in the loaded messages was, by
 * definition, already put in front of the model — seeded as decided. The
 * replacement strings are STORED, never re-derived, so a later change to
 * the preview template or path layout cannot silently break the prompt
 * cache. Records whose ids are not in the messages (post-compaction) are
 * inert. An inherited map gap-fills fork re-applies, which were never
 * persisted as records.
 */
export function reconstructContentReplacementState(
  messages: Message[],
  records: ContentReplacementRecord[],
  inheritedReplacements?: Map<string, string>,
): ContentReplacementState {
  const state = createContentReplacementState()
  const candidateIds = new Set<string>()
  for (const message of messages) {
    for (const candidate of collectCandidates(message)) {
      candidateIds.add(candidate.toolUseId)
      state.seenIds.add(candidate.toolUseId)
    }
  }
  for (const record of records) {
    if (record.kind !== 'tool-result') continue
    if (!candidateIds.has(record.toolUseId)) continue
    state.replacements.set(record.toolUseId, record.replacement)
  }
  if (inheritedReplacements) {
    for (const [toolUseId, replacement] of inheritedReplacements) {
      if (candidateIds.has(toolUseId) && !state.replacements.has(toolUseId)) {
        state.replacements.set(toolUseId, replacement)
      }
    }
  }
  return state
}

/** Nothing when the parent state is absent (feature off); otherwise a sidechain reconstruction gap-filled by the parent's live map. */
export function reconstructForSubagentResume(
  parentState: ContentReplacementState | undefined,
  resumedMessages: Message[],
  sidechainRecords: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  if (!parentState) return undefined
  return reconstructContentReplacementState(resumedMessages, sidechainRecords, parentState.replacements)
}
