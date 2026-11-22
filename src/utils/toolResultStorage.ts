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
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


export const TOOL_RESULTS_SUBDIR: Unbuilt = unbuilt('src/utils/toolResultStorage.ts:19')
export const PERSISTED_OUTPUT_TAG: Unbuilt = unbuilt('src/utils/toolResultStorage.ts:20')
export const PERSISTED_OUTPUT_CLOSING_TAG: Unbuilt = unbuilt('src/utils/toolResultStorage.ts:21')
export const TOOL_RESULT_CLEARED_MESSAGE: Unbuilt = unbuilt('src/utils/toolResultStorage.ts:22')

export const PREVIEW_SIZE_CHARS: Unbuilt = unbuilt('src/utils/toolResultStorage.ts:24')
export const PREVIEW_MAX_LINE_CHARS: Unbuilt = unbuilt('src/utils/toolResultStorage.ts:25')

type PersistedToolResult = Unbuilt

type PersistToolResultError = Unbuilt

function isPersistError(
  result: PersistedToolResult | PersistToolResultError,
): result is PersistToolResultError {
  return notBuilt('src/utils/toolResultStorage.ts:37')
}

export type ToolResultReplacementRecord = Unbuilt

export type ContentReplacementRecord = Unbuilt

export type ContentReplacementState = Unbuilt

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
  return notBuilt('src/utils/toolResultStorage.ts:263')
}

export async function processPreMappedToolResultBlock(
  block: ToolResultBlockParam,
  toolName: string,
  maxResultSizeChars: number,
  room?: ResultRoomShare,
  model?: string,
): Promise<ToolResultBlockParam> {
  return notBuilt('src/utils/toolResultStorage.ts:274')
}

export function createContentReplacementState(): ContentReplacementState {
  return notBuilt('src/utils/toolResultStorage.ts:284')
}

export function cloneContentReplacementState(source: ContentReplacementState): ContentReplacementState {
  return notBuilt('src/utils/toolResultStorage.ts:288')
}

export async function enforceToolResultBudget(
  messages: Message[],
  state: ContentReplacementState,
  skipToolNames?: ReadonlySet<string>,
  model?: string,
): Promise<{ messages: Message[]; replacements: ToolResultReplacementRecord[] }> {
  return notBuilt('src/utils/toolResultStorage.ts:314')
}

export async function applyToolResultBudget(
  messages: Message[],
  state: ContentReplacementState | undefined,
  writeToTranscript?: (records: ToolResultReplacementRecord[]) => void | Promise<void>,
  skipToolNames?: ReadonlySet<string>,
  model?: string,
): Promise<Message[]> {
  return notBuilt('src/utils/toolResultStorage.ts:468')
}

export function reconstructContentReplacementState(
  messages: Message[],
  records: ContentReplacementRecord[],
  inheritedReplacements?: Map<string, string>,
): ContentReplacementState {
  return notBuilt('src/utils/toolResultStorage.ts:483')
}

export function reconstructForSubagentResume(
  parentState: ContentReplacementState | undefined,
  resumedMessages: Message[],
  sidechainRecords: ContentReplacementRecord[],
): ContentReplacementState | undefined {
  return notBuilt('src/utils/toolResultStorage.ts:511')
}
