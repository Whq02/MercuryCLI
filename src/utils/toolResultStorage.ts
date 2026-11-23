import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { sliceHeadAtGrapheme, sliceTailAtGrapheme } from './intl.js'
import { join } from 'node:path'

import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import type { Tool } from '../Tool.js'
import type { Message } from '../types/message.js'
import type { ToolResultBlockParam } from '../types/wire.js'
import { DEFAULT_MAX_RESULT_SIZE_CHARS, toolResultBudgetsForWindow } from '../constants/toolLimits.js'
import { resolveContextWindow } from './model/capabilities.js'
import { logForDebugging } from './debug.js'
import { errorMessage, getErrnoCode, getErrnoPath } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'
import { getProjectDir } from './sessionStorage/paths.js'
import { passedOver } from './passedOver.js'

export const TOOL_RESULTS_SUBDIR = 'tool-results'
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'
export const TOOL_RESULT_CLEARED_MESSAGE = '[stale tool result pruned — content cleared]'

export const PREVIEW_SIZE_CHARS = 2000
export const PREVIEW_MAX_LINE_CHARS = 400

type PersistedToolResult = { filepath: string; originalSize: number; isJson: boolean; preview: string; hasMore: boolean }

type PersistToolResultError = { error: string }

function isPersistError(
  result: PersistedToolResult | PersistToolResultError,
): result is PersistToolResultError {
  return Object.hasOwn(result, 'error')
}

export type ToolResultReplacementRecord = { kind: 'tool-result'; toolUseId: string; replacement: string }

export type ContentReplacementRecord = ToolResultReplacementRecord

export type ContentReplacementState = { seenIds: Set<string>; replacements: Map<string, string>; budgetChars?: number }

function getPersistenceThreshold(declaredMaxResultSizeChars: number, model?: string): number {
  if (!Number.isFinite(declaredMaxResultSizeChars)) return declaredMaxResultSizeChars
  return Math.min(declaredMaxResultSizeChars, resultBudgetsForModel(model).resultChars)
}

function resultBudgetsForModel(model?: string): ReturnType<typeof toolResultBudgetsForWindow> {
  const window = model ? resolveContextWindow(model) : undefined
  return toolResultBudgetsForWindow(window?.source === 'fallback' ? undefined : window?.effectiveWindow)
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
  } catch (error) {
    passedOver(error)
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

function clampLine(line: string): string {
  if (line.length <= PREVIEW_MAX_LINE_CHARS) return line
  return `${sliceHeadAtGrapheme(line, PREVIEW_MAX_LINE_CHARS)} …[line clamped: ${line.length} chars]`
}

function clampLines(text: string): string {
  return text.split('\n').map(clampLine).join('\n')
}

export function generatePreview(content: string, maxBytes: number, outputBytes?: number): { preview: string; hasMore: boolean } {
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
  const skipped = Math.max(
    0,
    outputBytes === undefined
      ? content.length - head.length - tail.length
      : outputBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8'),
  )
  const preview = `${clampLines(head)}\n… [${formatFileSize(skipped)} skipped — full output persisted] …\n${clampLines(tail)}`
  return { preview, hasMore: true }
}

type TextBlockLike = { type?: string; text?: string }

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

export async function readPersistedToolResult(toolUseId: string): Promise<string | null> {
  try {
    return await readFile(getToolResultPath(toolUseId, false), 'utf8')
  } catch (error) {
    passedOver(error)
  }
  try {
    const blocks = JSON.parse(await readFile(getToolResultPath(toolUseId, true), 'utf8')) as TextBlockLike[]
    return blocks
      .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function buildLargeToolResultMessage(result: PersistedToolResult, cutWords?: string): string {
  return (
    `${PERSISTED_OUTPUT_TAG}\n` +
    `Output of ${formatFileSize(result.originalSize)}, too large to carry whole${cutWords === undefined ? '' : ` (${cutWords})`}. Full output saved to: ${result.filepath}\n\n` +
    `Preview (head + tail, ~${PREVIEW_SIZE_CHARS} chars; long lines clamped):\n` +
    `${result.preview}\n` +
    PERSISTED_OUTPUT_CLOSING_TAG
  )
}

export type ResultRoomShare = { shareChars: number; words: string }

export function clampResultToRoom(content: string, share: ResultRoomShare): string {
  if (content.length <= share.shareChars) return content
  const { preview } = generatePreview(content, share.shareChars)
  const cut = content.length - share.shareChars
  return `${preview.replace(/\n… \[[^\n]*skipped — full output persisted\] …\n/, `\n… [${cut.toLocaleString('en-US')} characters cut: ${share.words}; the result was clamped to ${share.shareChars.toLocaleString('en-US')} characters of head and tail — ask for less, or read in pieces] …\n`)}`
}

function isToolResultContentEmpty(content: unknown): boolean {
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
  room?: ResultRoomShare,
): Promise<ToolResultBlockParam> {
  const content = (block as { content?: unknown }).content
  if (isToolResultContentEmpty(content)) {
    return { ...block, content: `(The ${toolName} tool completed successfully with no output)` }
  }
  if (typeof content === 'string' && content.startsWith(PERSISTED_OUTPUT_TAG)) return block
  const declared = threshold ?? DEFAULT_MAX_RESULT_SIZE_CHARS
  const limit = room === undefined ? declared : Math.min(declared, room.shareChars)
  if (contentSizeOf(content) <= limit) return block
  if (!Number.isFinite(declared)) {
    if (room === undefined || typeof content !== 'string') return block
    return { ...block, content: clampResultToRoom(content, room) }
  }
  const roomBound = room !== undefined && contentSizeOf(content) <= declared
  const mixed = Array.isArray(content) && content.some(part => part.type !== 'text')
  const text = mixed ? (content as TextBlockLike[]).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n') : content
  const persisted = await persistToolResult(text as string | TextBlockLike[], block.tool_use_id)
  if (isPersistError(persisted)) return block
  const cutWords = [roomBound ? room.words : undefined, toolName === 'Computer' ? 'narrow with root or find' : undefined].filter(Boolean).join('; ') || undefined
  const replacement = buildLargeToolResultMessage(persisted, cutWords)
  if (!mixed) return { ...block, content: replacement }
  let inserted = false
  type ContentBlocks = Exclude<ToolResultBlockParam['content'], string | undefined>
  return { ...block, content: (content as ContentBlocks).flatMap((part): ContentBlocks => {
    if (part.type !== 'text') return [part]
    if (inserted) return []
    inserted = true
    return [{ type: 'text' as const, text: replacement }]
  }) }
}

export async function processToolResultBlock<T>(
  tool: Tool,
  toolUseResult: T,
  toolUseID: string,
  model?: string,
): Promise<ToolResultBlockParam> {
  const block = tool.mapToolResultToToolResultBlockParam(toolUseResult, toolUseID)
  const threshold = getPersistenceThreshold(tool.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS, model)
  return applySizePersistence(block, tool.name, threshold)
}

export async function processPreMappedToolResultBlock(
  block: ToolResultBlockParam,
  toolName: string,
  maxResultSizeChars: number,
  room?: ResultRoomShare,
  model?: string,
): Promise<ToolResultBlockParam> {
  return applySizePersistence(block, toolName, getPersistenceThreshold(maxResultSizeChars, model), room)
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() }
}

export function cloneContentReplacementState(source: ContentReplacementState): ContentReplacementState {
  return { ...source, seenIds: new Set(source.seenIds), replacements: new Map(source.replacements) }
}

type BudgetCandidate = { id: string; block: ToolResultBlockParam; content: NonNullable<ToolResultBlockParam['content']>; size: number }

function candidatesOf(row: Message): BudgetCandidate[] {
  if (row.type !== 'user' || !Array.isArray(row.message.content)) return []
  const candidates: BudgetCandidate[] = []
  for (const block of row.message.content) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const content = block.content
    if (content == null || hasImageBlock(content)) continue
    if (typeof content === 'string' && content.startsWith(TOOL_RESULT_CLEARED_MESSAGE)) continue
    candidates.push({ id: block.tool_use_id, block, content, size: contentSizeOf(content) })
  }
  return candidates
}
export async function enforceToolResultBudget(
  messages: Message[],
  state: ContentReplacementState,
  skipToolNames?: ReadonlySet<string>,
  model?: string,
): Promise<{ messages: Message[]; replacements: ToolResultReplacementRecord[] }> {
  const limit = state.budgetChars ?? resultBudgetsForModel(model).messageChars
  const names = new Map<string, string>()
  const responseIds = new Set<string>()
  const groups: BudgetCandidate[][] = []
  let group: BudgetCandidate[] = []
  for (const row of messages) {
    if (row.type === 'assistant') {
      const { id, content } = row.message
      if (id && !responseIds.has(id)) {
        responseIds.add(id)
        if (group.length) groups.push(group)
        group = []
      }
      if (skipToolNames?.size && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') names.set(block.id, block.name)
        }
      }
    } else if (row.type === 'user') {
      for (const candidate of candidatesOf(row)) group.push(candidate)
    }
  }
  if (group.length) groups.push(group)

  const applied = new Map<ToolResultBlockParam, string>()
  const replacements: ToolResultReplacementRecord[] = []
  let overBudget = 0
  let shed = 0
  let replayed = 0
  for (const batch of groups) {
    let size = 0
    const fresh: BudgetCandidate[] = []
    for (const candidate of batch) {
      const id = candidate.id
      const pointer = state.replacements.get(id)
      if (pointer !== undefined) {
        replayed++
        if (candidate.content !== pointer) applied.set(candidate.block, pointer)
      } else if (state.seenIds.has(id)) {
        size += candidate.size
      } else {
        const name = names.get(id)
        if (name !== undefined && skipToolNames?.has(name)) continue
        fresh.push(candidate)
        size += candidate.size
      }
    }
    for (const candidate of batch) state.seenIds.add(candidate.id)
    if (!fresh.length || size <= limit) continue
    overBudget++
    for (const candidate of fresh.sort((a, b) => b.size - a.size)) {
      if (size <= limit) break
      size -= candidate.size
      const toolUseId = candidate.id
      const stored = await persistToolResult(candidate.content, toolUseId)
      if (isPersistError(stored)) continue
      const replacement = buildLargeToolResultMessage(stored)
      state.replacements.set(toolUseId, replacement)
      applied.set(candidate.block, replacement)
      replacements.push({ kind: 'tool-result', toolUseId, replacement })
      shed += candidate.size
    }
  }
  if (replacements.length) {
    logForDebugging(`tool-result budget: persisted ${replacements.length} results across ${overBudget} over-budget messages (~${shed} chars shed, ${replayed} re-applied)`)
  }
  if (!applied.size) return { messages, replacements }
  const view = messages.map(row => {
    if (row.type !== 'user' || !Array.isArray(row.message.content)) return row
    if (!row.message.content.some(block => block.type === 'tool_result' && applied.has(block))) return row
    const content = row.message.content.map(block => {
      if (block.type !== 'tool_result') return block
      const replacement = applied.get(block)
      return replacement === undefined ? block : { ...block, content: replacement }
    })
    return { ...row, message: { ...row.message, content } }
  })
  return { messages: view, replacements }
}

export async function applyToolResultBudget(
  messages: Message[],
  state: ContentReplacementState | undefined,
  writeToTranscript?: (records: ToolResultReplacementRecord[]) => void | Promise<void>,
  skipToolNames?: ReadonlySet<string>,
  model?: string,
): Promise<Message[]> {
  if (!state) return messages
  const view = await enforceToolResultBudget(messages, state, skipToolNames, model)
  if (view.replacements.length && writeToTranscript) await writeToTranscript(view.replacements)
  return view.messages
}

export function reconstructContentReplacementState(
  messages: Message[],
  records: ContentReplacementRecord[],
  inheritedReplacements?: Map<string, string>,
): ContentReplacementState {
  const state = createContentReplacementState()
  for (const row of messages) {
    for (const { id } of candidatesOf(row)) state.seenIds.add(id)
  }
  for (const { kind, toolUseId, replacement } of records) {
    if (kind === 'tool-result' && state.seenIds.has(toolUseId)) state.replacements.set(toolUseId, replacement)
  }
  for (const [id, text] of inheritedReplacements ?? []) {
    if (state.seenIds.has(id) && !state.replacements.has(id)) state.replacements.set(id, text)
  }
  return state
}

export function reconstructForSubagentResume(
  parentState: ContentReplacementState | undefined,
  resumedMessages: Message[],
  sidechainRecords: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  if (!parentState) return undefined
  const state = reconstructContentReplacementState(resumedMessages, sidechainRecords, parentState.replacements)
  if (parentState.budgetChars !== undefined) state.budgetChars = parentState.budgetChars
  return state
}
