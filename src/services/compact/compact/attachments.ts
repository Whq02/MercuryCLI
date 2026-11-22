import { closeSync, readSync } from 'node:fs'
import { parse, relative } from 'node:path'
import { getInvokedSkillsForAgent } from '../../../bootstrap/state.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage, AttachmentMessage, Message, UserMessage } from '../../../types/message.js'
import { getAgentRosterAttachment, queuedNoticeTaskIds } from '../../attachments/agentRoster.js'
import { getPlannedDeferredToolsAttachment, getMcpInstructionsDeltaAttachment } from '../../attachments/deltas.js'
import { generateFileAttachment } from '../../attachments/fileAttachments.js'
import { createAttachmentMessage } from '../../attachments/orchestrator.js'
import type { Attachment } from '../../../utils/attachments/types.js'
import { isFileReadDenied } from '../../../utils/attachments/shared.js'
import { getUserContextAttachment } from '../../../utils/attachments/userContext.js'
import { getMemoryPath } from '../../../utils/config/derived.js'
import { getCwd } from '../../../utils/cwd.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getDefaultFileReadingLimits } from '../../../utils/fileReadLimits.js'
import { isImageFilePath } from '../../../utils/imagePaste.js'
import { getCommandQueue } from '../../../utils/messageQueueManager.js'
import { MEMORY_TYPE_VALUES } from '../../../utils/memory/types.js'
import { expandPath } from '../../../utils/path.js'
import type { FileState } from '../../../utils/fileStateCache.js'
import { isRemotePath } from '../../../utils/remoteFiles/target.js'
import { openRegularFileSync } from '../../../utils/regularFile.js'
import { isPDFExtension } from '../../pdfUtils.js'
import { isInstructionFilePath } from '../../../services/instructions/engine.js'
import { roughTokenCountEstimation } from '../../tokenEstimation.js'
import { PERSISTED_OUTPUT_TAG, TOOL_RESULT_CLEARED_MESSAGE } from '../../../utils/toolResultStorage.js'
import { REPEATED_RESULT_TAG } from '../../../constants/toolLimits.js'
import { FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB, MAX_LINES_TO_READ } from '../../../constants/tools/fileRead.js'
import { estimateContextTokens } from '../microCompact.js'
import { FOLDED_RESULT_KEY } from '../verbatimTail.js'
import { POST_COMPACT_MAX_FILES_TO_RESTORE, POST_COMPACT_TOKEN_BUDGET, POST_COMPACT_MAX_TOKENS_PER_FILE, POST_COMPACT_MAX_TOKENS_PER_SKILL, POST_COMPACT_SKILLS_TOKEN_BUDGET, ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD } from './limits.js'
import { type CompactionResult, buildPostCompactMessages } from './result.js'
import { passedOver, passedOverAs } from '../../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

export function collectPreservedReadPaths(preserved: Message[], resultIds?: ReadonlySet<string>): Set<string> {
  return notBuilt('src/services/compact/compact/attachments.ts:48')
}

export function linesWithinTokenCeiling(lines: readonly string[], maxTokens: number): number {
  let shown = ''
  for (let count = 0; count < lines.length; count++) {
    shown += `${lines[count]!}\n`
    if (roughTokenCountEstimation(shown) > maxTokens) return Math.max(1, count)
  }
  return lines.length
}

export function fitFileAttachmentToTokenCeiling<T extends Attachment>(row: T, maxTokens: number): T {
  if (row.type !== 'file' || row.content.type !== 'text') return row
  const lines = row.content.file.content.split('\n')
  const count = linesWithinTokenCeiling(lines, maxTokens)
  if (count >= lines.length) return row
  const shown = lines.slice(0, count)
  return { ...row, truncated: true, content: { ...row.content, file: { ...row.content.file, content: shown.join('\n'), numLines: shown.length } } }
}

function projectedFileAttachment(
  path: string,
  state: { content: string; timestamp: number },
  toolUseContext: ToolUseContext,
): Attachment | null {
  if (isRemotePath(path)) return null
  if (isFileReadDenied(path, toolUseContext.getAppState().toolPermissionContext)) return null
  const displayPath = relative(getCwd(), path)
  const fallback = (): Attachment => {
    const lines = state.content.split('\n')
    return {
      type: 'file',
      filename: path,
      displayPath: path,
      content: { type: 'text', file: { filePath: path, content: state.content, numLines: lines.length, startLine: 1, totalLines: lines.length } },
    }
  }
  if (isImageFilePath(path) || isPDFExtension(parse(path).ext.toLowerCase())) return fallback()
  let opened: ReturnType<typeof openRegularFileSync>
  try {
    opened = openRegularFileSync(path)
  } catch (error) {
    passedOver(error)
    return fallback()
  }
  const { fd, stats } = opened
  try {
    if (!stats.isFile()) return null
    const limits = getDefaultFileReadingLimits()
    if (stats.size > limits.maxSizeBytes) return { type: 'compact_file_reference', filename: path, displayPath }
    const maxBytes = Math.min(stats.size, limits.maxTokens * 4 + 4_096)
    const buffer = Buffer.alloc(maxBytes)
    const bytesRead = maxBytes > 0 ? readSync(fd, buffer, 0, maxBytes, 0) : 0
    const slice = buffer.subarray(0, bytesRead)
    if (slice.includes(0)) return fallback()
    const raw = slice.toString('utf8')
    const allLines = raw.split('\n')
    const shown = allLines.slice(0, MAX_LINES_TO_READ)
    const content = shown.join('\n')
    if (roughTokenCountEstimation(content) > limits.maxTokens) return { type: 'compact_file_reference', filename: path, displayPath }
    return {
      type: 'file',
      filename: path,
      displayPath,
      content: { type: 'text', file: { filePath: path, content, numLines: shown.length, startLine: 1, totalLines: allLines.length } },
    }
  } catch (error) {
    passedOver(error)
    return fallback()
  } finally {
    closeSync(fd)
  }
}

export async function createPostCompactFileAttachments(
  readFileState: Record<string, { content: string; timestamp: number }>,
  toolUseContext: ToolUseContext,
  maxFiles: number,
  preservedMessages?: Message[],
  project?: boolean,
): Promise<AttachmentMessage[]> {
  return notBuilt('src/services/compact/compact/attachments.ts:157')
}


const POST_COMPACT_SHEDDABLE_ATTACHMENT_TYPES = ['file', 'compact_file_reference', 'invoked_skills'] as const

export type PostCompactFit = {
  result: CompactionResult
  estimate: number
  shed: string[]
}

function describeAttachment(message: AttachmentMessage): string {
  const attachment = message.attachment as { type: string; filename?: string }
  if (attachment.type === 'file' || attachment.type === 'compact_file_reference') return `file ${attachment.filename ?? '?'}`
  if (attachment.type === 'compact_operator_messages') return 'operator messages'
  return attachment.type
}

export function fitPostCompactUnderThreshold(result: CompactionResult, threshold: number, count?: Unbuilt): PostCompactFit {
  return notBuilt('src/services/compact/compact/attachments.ts:227')
}

export function obligationsOverThresholdMessage(estimate: number, threshold: number): string {
  return (
    `${ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD}: the fixed material (${estimate} tokens: the system prompt, the tool definitions ` +
    `and this stretch's messages) exceeds the window's ceiling (${threshold} tokens) — ` +
    `compaction cannot run here, so no summary was requested and the original context is kept whole; nothing moved. Start a fresh conversation with /clear, ` +
    `or switch to a model with a larger window.`
  )
}

export function postCompactOverThresholdMessage(estimate: number, threshold: number): string {
  return (
    `${ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD}: with every restorable attachment dropped, the summary, ` +
    `the kept tail and the session-start hook output still estimate ${estimate} tokens against a ` +
    `${threshold}-token threshold. The original context is kept whole; nothing moved. Start a fresh conversation with /clear, or trim the hook output.`
  )
}

export function createSkillAttachmentIfNeeded(
  agentId?: string,
  catalogue?: ReadonlyArray<{ name: string }>,
): AttachmentMessage | null {
  return notBuilt('src/services/compact/compact/attachments.ts:270')
}

export async function createAsyncAgentAttachmentsIfNeeded(context: ToolUseContext): Promise<AttachmentMessage[]> {
  return notBuilt('src/services/compact/compact/attachments.ts:297')
}

export function snapshotAndClearReadState(context: ToolUseContext): Record<string, { content: string; timestamp: number }> {
  return notBuilt('src/services/compact/compact/attachments.ts:307')
}

export function restorePreservedReads(
  context: ToolUseContext,
  ledger: Array<[string, FileState]>,
  preserved: Message[],
): string[] {
  const preservedReads = collectPreservedReadPaths(preserved)
  const restored: string[] = []
  for (const [path, state] of ledger) {
    if (!preservedReads.has(expandPath(path))) continue
    context.readFileState.set(path, state)
    restored.push(path)
  }
  return restored
}

export function restoreReadState(
  context: ToolUseContext,
  ledger: Array<[string, FileState]>,
  nestedMemoryPaths?: readonly string[],
): void {
  context.readFileState.clear()
  for (const [path, state] of ledger) context.readFileState.set(path, state)
  if (nestedMemoryPaths !== undefined && context.loadedNestedMemoryPaths !== undefined) {
    context.loadedNestedMemoryPaths.clear()
    for (const path of nestedMemoryPaths) context.loadedNestedMemoryPaths.add(path)
  }
}

export async function assembleAttachments(
  snapshot: Record<string, { content: string; timestamp: number }>,
  context: ToolUseContext,
  preserved: Message[],
  callSite: 'compact_full' | 'compact_partial',
  ledger: Array<[string, FileState]>,
  projection?: { userContext: Record<string, string> },
  restoreFiles?: boolean,
): Promise<AttachmentMessage[]> {
  return notBuilt('src/services/compact/compact/attachments.ts:345')
}
