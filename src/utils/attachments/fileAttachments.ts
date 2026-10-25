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
import { cacheKeys, type FileState } from '../fileStateCache.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { expandPath } from '../path.js'
import { getPDFPageCount } from '../pdf.js'
import { isPDFExtension } from '../pdfUtils.js'
import { FileTooLargeError } from '../readFileInRange.js'
import { countCharInString } from '../stringUtils.js'
import { isFileReadDenied } from './shared.js'
import type { AlreadyReadFileAttachment, Attachment, CompactFileReferenceAttachment, FileAttachment, PDFReferenceAttachment } from './types.js'

type FileRow = FileAttachment | CompactFileReferenceAttachment | PDFReferenceAttachment | AlreadyReadFileAttachment
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

async function oversizedFallback(input: ReadRequest, context: ToolUseContext, mode: ReadMode): Promise<FileRow | null> {
  if (modes[mode].oversizedReference) return { type: 'compact_file_reference', filename: input.file_path, displayPath: displayOf(input.file_path) }
  if (isFileReadDenied(input.file_path, context.getAppState().toolPermissionContext)) return null
  return fileRow({ file_path: input.file_path, offset: input.offset ?? 1, limit: MAX_LINES_TO_READ }, context, true)
}

async function validatedRead(input: ReadRequest, context: ToolUseContext, mode: ReadMode): Promise<FileRow | null> {
  try {
    if (!(await FileReadTool.validateInput(input, context)).result) return null
    try {
      return await fileRow(input, context)
    } catch (failure) {
      if (!(failure instanceof MaxFileReadTokenExceededError || failure instanceof FileTooLargeError)) return null
      return await oversizedFallback(input, context, mode)
    }
  } catch {
    return null
  }
}

async function tooLargeToMention(filename: string): Promise<boolean> {
  if (isFileWithinReadSizeLimit(filename, getDefaultFileReadingLimits().maxSizeBytes) || pdfPath(filename)) return false
  try {
    await getFsImplementation().stat(filename)
    return true
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
  if (plan.checkSize && await tooLargeToMention(filename)) return null
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

async function changedContent(filename: string, previous: string, output: ReadOutput): Promise<Attachment[]> {
  switch (output.type) {
    case 'text': {
      const snippet = getSnippetForTwoFileDiff(previous, output.file.content)
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
  if (!previous || (previous.offset ?? 0) !== 0 || previous.limit !== undefined) return []
  const path = expandPath(key)
  if (isFileReadDenied(path, state.toolPermissionContext)) return []
  try {
    if (await getFileModificationTimeAsync(path) <= previous.timestamp) return []
    if (isDirectoryTarget(path)) {
      context.readFileState.delete(key)
      return []
    }
    const input = { file_path: path }
    if (!(await FileReadTool.validateInput(input, context)).result) return []
    const read = await FileReadTool.call(input, context)
    const now = context.readFileState.get(path)
    if (now !== undefined) context.readFileState.set(path, { ...now, offset: undefined })
    return await changedContent(path, previous.content, read.data)
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
