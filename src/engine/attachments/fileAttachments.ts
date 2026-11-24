import { parse, relative } from 'path'
import { getCwd } from 'src/platform/files/cwd.js'
import { getSnippetForTwoFileDiff } from 'src/tools/edit/call/editMatching.js'
import { getDefaultFileReadingLimits } from 'src/tools/read/call/fileReadLimits.js'
import { MAX_LINES_TO_READ } from 'src/tools/kit/names/fileRead.js'
import { PDF_AT_MENTION_INLINE_THRESHOLD } from '../../models/roads/mediaLimits.js'
import { isRemotePath } from '../../platform/remote-file-target/target.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import { ReadTool, MaxFileReadTokenExceededError, readImageWithTokenBudget, type Output as ReadOutput } from '../../tools/read/ReadTool.js'
import { isDirectoryTarget } from '../../tools/read/readTarget.js'
import { isENOENT } from '../../platform/errors/errors.js'
import { getFileModificationTimeAsync, isFileWithinReadSizeLimit } from '../../platform/files/file.js'
import { formatFileSize } from '../../platform/text/format.js'
import { isImageFilePath } from '../../screen/composer/imagePaste.js'
import { cacheKeys, type FileState } from '../../platform/files/fileStateCache.js'
import { getFsImplementation } from '../../platform/files/fsOperations.js'
import { logError } from '../../platform/logs/errorLog.js'
import { expandPath } from '../../platform/files/path.js'
import { getPDFPageCount } from '../../tools/kit/pdf.js'
import { isPDFExtension } from '../../tools/kit/pdfSupport.js'
import { ImageResizeError } from '../../platform/images/imageResizer.js'
import { FileTooLargeError } from '../../platform/files/readFileInRange.js'
import { countCharInString } from '../../platform/text/strings.js'
import { ruleSentence } from '../../permissions/rules/ruleReason.js'
import { matchingRuleForInput } from '../../permissions/rules/filesystem.js'
import { isFileReadDenied } from '../attachment-shapes/fileReadDenied.js'
import type { AlreadyReadFileAttachment, Attachment, FoldFileReferenceAttachment, DroppedImageAttachment, FileAttachment, PDFReferenceAttachment } from '../attachment-shapes/attachmentTypes.js'
import { passedOver } from '../../platform/errors/passedOver.js'

type FileRow =
  | FileAttachment
  | AlreadyReadFileAttachment
  | FoldFileReferenceAttachment
  | PDFReferenceAttachment
  | DroppedImageAttachment
type ReadWindow = { offset?: number; limit?: number }
type ReadRequest = ReadWindow & { file_path: string }
type ReadMode = 'compact' | 'at-mention'
const modes = {
  compact: { checkSize: false, referencePDF: false, reuseRead: false, oversizedReference: true },
  'at-mention': { checkSize: true, referencePDF: true, reuseRead: true, oversizedReference: false },
} as const
const PDF_ESTIMATED_BYTES_PER_PAGE = 102400
const displayOf = (filename: string): string => relative(getCwd(), filename)
const pdfPath = (filename: string): boolean => isPDFExtension(parse(filename).ext.toLowerCase())

async function fileRow(input: ReadRequest, context: ToolUseContext, clipped = false): Promise<FileAttachment> {
  const answer = await ReadTool.call(input, context)
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
    if (!(await ReadTool.validateInput(input, context)).result) return null
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

export function droppedMentionLine(row: Pick<DroppedImageAttachment, 'displayPath' | 'reason'>): string {
  return `Dropped ${row.displayPath} — ${row.reason}`
}

export function mentionPastCeiling(filename: string, seconds: number): DroppedImageAttachment {
  const reason = `Reading it took longer than ${seconds} seconds.`
  return isImageFilePath(filename) ? droppedImage(filename, reason) : droppedUnread(filename, reason, 'retry')
}

export function mentionDeniedByRule(filename: string, permissions: Parameters<typeof matchingRuleForInput>[1]): DroppedImageAttachment | null {
  const rule = matchingRuleForInput(filename, permissions, 'read', 'deny')
  return rule === null ? null : droppedUnread(filename, ruleSentence(`Reading ${filename}`, 'deny', rule), 'refused')
}

export function mentionReadFailed(filename: string, failure: unknown): DroppedImageAttachment {
  const line = (failure instanceof Error ? failure.message : String(failure)).split('\n')[0]!.trim().replace(/\.+$/, '')
  return droppedUnread(filename, `Reading it failed: ${line}.`, 'refused')
}

async function unreadMention(filename: string, context: ToolUseContext, mode: ReadMode, failure: unknown): Promise<FileRow | null> {
  if (mode !== 'at-mention' || context.abortController.signal.aborted) return null
  let standing = true
  try {
    standing = (await getFsImplementation().stat(filename)).isFile()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    standing = code !== 'ENOENT' && code !== 'ENOTDIR'
  }
  if (!standing) return null
  return mentionReadFailed(filename, failure)
}

async function tooLargeToMention(filename: string): Promise<FileRow | null | false> {
  const limit = getDefaultFileReadingLimits().maxSizeBytes
  if (isFileWithinReadSizeLimit(filename, limit) || pdfPath(filename)) return false
  try {
    const { size } = await getFsImplementation().stat(filename)
    return isImageFilePath(filename)
      ? droppedImage(filename, `The image is ${formatFileSize(size)}, over the ${formatFileSize(limit)} limit for a mentioned file.`)
      : droppedUnread(filename, `The file is ${formatFileSize(size)}, over the ${formatFileSize(limit)} limit for a mentioned file.`, 'retry')
  } catch (error) {
    passedOver(error)
    return false
  }
}

function alreadyReadRow(filename: string, cached: FileState, startLine: number): AlreadyReadFileAttachment {
  const numLines = countCharInString(cached.content, '\n') + 1
  return {
    type: 'already_read_file',
    filename,
    displayPath: displayOf(filename),
    content: {
      type: 'text',
      file: {
        filePath: filename,
        content: cached.content,
        numLines,
        startLine,
        totalLines: numLines,
      },
    },
  }
}

async function reusableRead(filename: string, context: ToolUseContext, offset?: number): Promise<AlreadyReadFileAttachment | null> {
  const cached = context.readFileState.get(filename)
  if (!cached) return null
  if ((cached.offset ?? 0) !== 0 || cached.limit !== undefined) return null
  try {
    if (await getFileModificationTimeAsync(filename) !== cached.timestamp) return null
  } catch (error) {
    passedOver(error)
    return null
  }
  return alreadyReadRow(filename, cached, offset ?? 1)
}

export async function generateFileAttachment(filename: string, context: ToolUseContext, mode: ReadMode, options?: ReadWindow): Promise<FileRow | null> {
  if (isRemotePath(filename) || isFileReadDenied(filename, context.getAppState().toolPermissionContext)) return null
  const policy = modes[mode]
  if (policy.checkSize) {
    const oversized = await tooLargeToMention(filename)
    if (oversized !== false) return oversized
  }
  if (policy.referencePDF) {
    const pdf = await tryGetPDFReference(filename)
    if (pdf !== null) return pdf
  }
  if (policy.reuseRead) {
    const cached = await reusableRead(filename, context, options?.offset)
    if (cached !== null) return cached
  }
  return validatedRead({ file_path: filename, offset: options?.offset, limit: options?.limit }, context, mode)
}

export async function tryGetPDFReference(filename: string): Promise<PDFReferenceAttachment | null> {
  if (!pdfPath(filename)) return null
  try {
    const stats = await getFsImplementation().stat(filename)
    if (!stats.isFile()) return null
    const measured = await getPDFPageCount(filename)
    const pageCount = measured ?? Math.ceil(stats.size / PDF_ESTIMATED_BYTES_PER_PAGE)
    if (pageCount <= PDF_AT_MENTION_INLINE_THRESHOLD) return null
    return {
      type: 'pdf_reference',
      filename,
      displayPath: displayOf(filename),
      pageCount,
      fileSize: stats.size,
    }
  } catch (error) {
    passedOver(error)
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
  if (isRemotePath(key)) return []
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
    if (!(await ReadTool.validateInput(input, context)).result) return []
    const read = await ReadTool.call(input, context)
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
