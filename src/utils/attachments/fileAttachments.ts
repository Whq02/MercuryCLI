import { parse, relative } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import { getSnippetForTwoFileDiff } from 'src/tools/FileEditTool/utils.js'
import { getDefaultFileReadingLimits } from 'src/tools/FileReadTool/limits.js'
import { MAX_LINES_TO_READ } from 'src/tools/FileReadTool/prompt.js'
import { PDF_AT_MENTION_INLINE_THRESHOLD } from '../../constants/apiLimits.js'
import type { ToolUseContext } from '../../Tool.js'
import { FileReadTool, MaxFileReadTokenExceededError, readImageWithTokenBudget, type Output as ReadOutput } from '../../tools/FileReadTool/FileReadTool.js'
import { isDirectoryTarget } from '../../tools/FileReadTool/readTarget.js'
import { isENOENT } from '../errors.js'
import { getFileModificationTimeAsync, isFileWithinReadSizeLimit } from '../file.js'
import { formatFileSize } from '../format.js'
import { isImageFilePath } from '../imagePaste.js'
import { cacheKeys, type FileState } from '../fileStateCache.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { expandPath } from '../path.js'
import { getPDFPageCount } from '../pdf.js'
import { isPDFExtension } from '../pdfUtils.js'
import { ImageResizeError } from '../imageResizer.js'
import { FileTooLargeError } from '../readFileInRange.js'
import { countCharInString } from '../stringUtils.js'
import { ruleSentence } from '../permissions/ruleReason.js'
import { matchingRuleForInput } from '../permissions/filesystem.js'
import { isFileReadDenied } from './shared.js'
import type { AlreadyReadFileAttachment, Attachment, CompactFileReferenceAttachment, DroppedImageAttachment, FileAttachment, PDFReferenceAttachment } from './types.js'

type FileRow = FileAttachment | CompactFileReferenceAttachment | PDFReferenceAttachment | AlreadyReadFileAttachment | DroppedImageAttachment
type ReadWindow = { offset?: number; limit?: number }
type ReadRequest = ReadWindow & { file_path: string }
type ReadMode = 'compact' | 'at-mention'
const modes = {
  compact: { checkSize: false, referencePDF: false, reuseRead: false, oversizedReference: true },
  'at-mention': { checkSize: true, referencePDF: true, reuseRead: true, oversizedReference: false },
} as const
const displayOf = (filename: string): string => relative(getCwd(), filename)
const pdfPath = (filename: string): boolean => isPDFExtension(parse(filename).ext.toLowerCase())

async function fileRow(input: ReadRequest, context: ToolUseContext, clipped = false): Promise<FileAttachment> {
  const answer = await FileReadTool.call(input, context)
  return { type: 'file', filename: input.file_path, content: answer.data, displayPath: displayOf(input.file_path), ...(clipped ? { truncated: true } : {}) }
}

async function clippedRead(input: ReadRequest, context: ToolUseContext, window: Required<ReadWindow>): Promise<FileAttachment> {
  try {
    return await fileRow({ file_path: input.file_path, ...window }, context, true)
  } catch (failure) {
    if (!(failure instanceof MaxFileReadTokenExceededError) || failure.next === undefined || failure.next.limit >= window.limit) throw failure
    return clippedRead(input, context, failure.next)
  }
}

async function oversizedFallback(input: ReadRequest, context: ToolUseContext, mode: ReadMode, fits?: ReadWindow): Promise<FileRow | null> {
  if (modes[mode].oversizedReference) return { type: 'compact_file_reference', filename: input.file_path, displayPath: displayOf(input.file_path) }
  if (isFileReadDenied(input.file_path, context.getAppState().toolPermissionContext)) return null
  return clippedRead(input, context, { offset: fits?.offset ?? input.offset ?? 1, limit: fits?.limit ?? MAX_LINES_TO_READ })
}

async function validatedRead(input: ReadRequest, context: ToolUseContext, mode: ReadMode): Promise<FileRow | null> {
  try {
    if (!(await FileReadTool.validateInput(input, context)).result) return null
    try {
      return await fileRow(input, context)
    } catch (failure) {
      if (failure instanceof ImageResizeError) return droppedImage(input.file_path, failure.message)
      if (!(failure instanceof MaxFileReadTokenExceededError || failure instanceof FileTooLargeError)) throw failure
      return await oversizedFallback(input, context, mode, failure instanceof MaxFileReadTokenExceededError ? failure.next : undefined)
    }
  } catch (failure) {
    return unreadMention(input.file_path, context, mode, failure)
  }
}

const droppedImage = (filename: string, reason: string): DroppedImageAttachment => ({ type: 'dropped_image_file', filename, displayPath: displayOf(filename), reason })
const droppedUnread = (filename: string, reason: string, unread: 'retry' | 'refused'): DroppedImageAttachment => ({ ...droppedImage(filename, reason), unread })

export function mentionPastCeiling(filename: string, seconds: number): DroppedImageAttachment {
  const reason = `Reading it took longer than ${seconds} seconds.`
  return isImageFilePath(filename) ? droppedImage(filename, reason) : droppedUnread(filename, reason, 'retry')
}

export function mentionDeniedByRule(filename: string, permissions: Parameters<typeof matchingRuleForInput>[1]): DroppedImageAttachment | null {
  const rule = matchingRuleForInput(filename, permissions, 'read', 'deny')
  return rule === null ? null : droppedUnread(filename, ruleSentence(`Reading ${filename}`, 'deny', rule), 'refused')
}

async function unreadMention(filename: string, context: ToolUseContext, mode: ReadMode, failure: unknown): Promise<FileRow | null> {
  if (mode !== 'at-mention' || context.abortController.signal.aborted) return null
  const standing = await getFsImplementation().stat(filename).then(info => info.isFile()).catch(() => false)
  if (!standing) return null
  const line = (failure instanceof Error ? failure.message : String(failure)).split('\n')[0]!.trim().replace(/\.+$/, '')
  return droppedUnread(filename, `Reading it failed: ${line}.`, 'refused')
}

async function tooLargeToMention(filename: string): Promise<FileRow | null | false> {
  const limit = getDefaultFileReadingLimits().maxSizeBytes
  if (isFileWithinReadSizeLimit(filename, limit) || pdfPath(filename)) return false
  try {
    const { size } = await getFsImplementation().stat(filename)
    return isImageFilePath(filename)
      ? droppedImage(filename, `The image is ${formatFileSize(size)}, over the ${formatFileSize(limit)} limit for a mentioned file.`)
      : droppedUnread(filename, `The file is ${formatFileSize(size)}, over the ${formatFileSize(limit)} limit for a mentioned file.`, 'retry')
  } catch {
    return false
  }
}

async function reusableRead(filename: string, recorded: FileState, offset?: number): Promise<AlreadyReadFileAttachment | null> {
  try {
    if (await getFileModificationTimeAsync(filename) !== recorded.timestamp) return null
    const lines = countCharInString(recorded.content, '\n') + 1
    return {
      type: 'already_read_file', filename, displayPath: displayOf(filename),
      content: { type: 'text', file: { filePath: filename, content: recorded.content, numLines: lines, startLine: offset ?? 1, totalLines: lines } },
    }
  } catch {
    return null
  }
}

export async function generateFileAttachment(filename: string, context: ToolUseContext, mode: ReadMode, options?: ReadWindow): Promise<FileRow | null> {
  const { offset, limit } = options ?? {}
  const plan = modes[mode]
  if (isFileReadDenied(filename, context.getAppState().toolPermissionContext)) return null
  if (plan.checkSize) {
    const tooLarge = await tooLargeToMention(filename)
    if (tooLarge !== false) return tooLarge
  }
  if (plan.referencePDF) {
    const reference = await tryGetPDFReference(filename)
    if (reference) return reference
  }
  const recorded = context.readFileState.get(filename)
  if (recorded && plan.reuseRead) {
    const held = await reusableRead(filename, recorded, offset)
    if (held) return held
  }
  return validatedRead({ file_path: filename, offset, limit }, context, mode)
}

export async function tryGetPDFReference(filename: string): Promise<PDFReferenceAttachment | null> {
  if (!pdfPath(filename)) return null
  try {
    const measurements = await Promise.all([getFsImplementation().stat(filename), getPDFPageCount(filename)])
    const fileSize = measurements[0].size
    const pageCount = measurements[1] ?? Math.ceil(fileSize / 102400)
    return pageCount > PDF_AT_MENTION_INLINE_THRESHOLD
      ? { type: 'pdf_reference', filename, pageCount, fileSize, displayPath: displayOf(filename) }
      : null
  } catch {
    return null
  }
}

async function changedContent(filename: string, previous: string, output: ReadOutput, startLine = 1): Promise<Attachment[]> {
  switch (output.type) {
    case 'text': {
      const snippet = getSnippetForTwoFileDiff(previous, output.file.content, startLine)
      return snippet ? [{ type: 'edited_text_file', filename, snippet }] : []
    }
    case 'image':
      try {
        return [{ type: 'edited_image_file', filename, content: await readImageWithTokenBudget(filename) }]
      } catch (failure) {
        logError(failure)
      }
  }
  return []
}

async function changedFile(key: string, context: ToolUseContext, state: ReturnType<ToolUseContext['getAppState']>): Promise<Attachment[]> {
  const previous = context.readFileState.get(key)
  if (!previous) return []
  const windowed = (previous.offset ?? 0) !== 0 || previous.limit !== undefined
  if (windowed && previous.isPartialView) return []
  const path = expandPath(key)
  if (isFileReadDenied(path, state.toolPermissionContext)) return []
  try {
    if (await getFileModificationTimeAsync(path) <= previous.timestamp) return []
    if (isDirectoryTarget(path)) {
      context.readFileState.delete(key)
      return []
    }
    const input = { file_path: path, ...(windowed && previous.offset ? { offset: previous.offset } : {}), ...(windowed && previous.limit !== undefined ? { limit: previous.limit } : {}) }
    if (!(await FileReadTool.validateInput(input, context)).result) return []
    const read = await FileReadTool.call(input, context)
    if (windowed) context.readFileState.delete(path)
    else {
      const now = context.readFileState.get(path)
      if (now !== undefined) context.readFileState.set(path, { ...now, offset: undefined })
    }
    return await changedContent(path, previous.content, read.data, Math.max(1, previous.offset ?? 1))
  } catch (failure) {
    if (isENOENT(failure)) context.readFileState.delete(key)
    return []
  }
}

export async function getChangedFiles(context: ToolUseContext): Promise<Attachment[]> {
  const keys = cacheKeys(context.readFileState)
  if (!keys.length) return []
  const state = context.getAppState()
  return (await Promise.all(keys.map(key => changedFile(key, context, state)))).flat()
}
