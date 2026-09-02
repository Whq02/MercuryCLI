
import { parse, relative } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import { getSnippetForTwoFileDiff } from 'src/tools/FileEditTool/utils.js'
import { getDefaultFileReadingLimits } from 'src/tools/FileReadTool/limits.js'
import { MAX_LINES_TO_READ } from 'src/tools/FileReadTool/prompt.js'
import { PDF_AT_MENTION_INLINE_THRESHOLD } from '../../constants/apiLimits.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  FileReadTool,
  MaxFileReadTokenExceededError,
  readImageWithTokenBudget,
} from '../../tools/FileReadTool/FileReadTool.js'
import { isENOENT } from '../errors.js'
import {
  getFileModificationTimeAsync,
  isFileWithinReadSizeLimit,
} from '../file.js'
import { cacheKeys } from '../fileStateCache.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { expandPath } from '../path.js'
import { getPDFPageCount } from '../pdf.js'
import { isPDFExtension } from '../pdfUtils.js'
import { FileTooLargeError } from '../readFileInRange.js'
import { countCharInString } from '../stringUtils.js'
import { isFileReadDenied } from './shared.js'
import type {
  AlreadyReadFileAttachment,
  Attachment,
  CompactFileReferenceAttachment,
  FileAttachment,
  PDFReferenceAttachment,
} from './types.js'

export async function getChangedFiles(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const filePaths = cacheKeys(toolUseContext.readFileState)
  if (filePaths.length === 0) return []

  const appState = toolUseContext.getAppState()
  const results = await Promise.all(
    filePaths.map(async filePath => {
      const fileState = toolUseContext.readFileState.get(filePath)
      if (!fileState) return null

      if (fileState.offset !== undefined || fileState.limit !== undefined) {
        return null
      }

      const normalizedPath = expandPath(filePath)

      if (isFileReadDenied(normalizedPath, appState.toolPermissionContext)) {
        return null
      }

      try {
        const mtime = await getFileModificationTimeAsync(normalizedPath)
        if (mtime <= fileState.timestamp) {
          return null
        }

        const fileInput = { file_path: normalizedPath }

        const isValid = await FileReadTool.validateInput(
          fileInput,
          toolUseContext,
        )
        if (!isValid.result) {
          return null
        }

        const result = await FileReadTool.call(fileInput, toolUseContext)
        if (result.data.type === 'text') {
          const snippet = getSnippetForTwoFileDiff(
            fileState.content,
            result.data.file.content,
          )

          if (snippet === '') {
            return null
          }

          return {
            type: 'edited_text_file' as const,
            filename: normalizedPath,
            snippet,
          }
        }

        if (result.data.type === 'image') {
          try {
            const data = await readImageWithTokenBudget(normalizedPath)
            return {
              type: 'edited_image_file' as const,
              filename: normalizedPath,
              content: data,
            }
          } catch (compressionError) {
            logError(compressionError)
            return null
          }
        }

        return null
      } catch (err) {
        if (isENOENT(err)) {
          toolUseContext.readFileState.delete(filePath)
        }
        return null
      }
    }),
  )
  return results.filter(result => result != null) as Attachment[]
}

export async function tryGetPDFReference(
  filename: string,
): Promise<PDFReferenceAttachment | null> {
  const ext = parse(filename).ext.toLowerCase()
  if (!isPDFExtension(ext)) {
    return null
  }
  try {
    const [stats, pageCount] = await Promise.all([
      getFsImplementation().stat(filename),
      getPDFPageCount(filename),
    ])
    const effectivePageCount = pageCount ?? Math.ceil(stats.size / (100 * 1024))
    if (effectivePageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      return {
        type: 'pdf_reference',
        filename,
        pageCount: effectivePageCount,
        fileSize: stats.size,
        displayPath: relative(getCwd(), filename),
      }
    }
  } catch {
  }
  return null
}

export async function generateFileAttachment(
  filename: string,
  toolUseContext: ToolUseContext,
  mode: 'compact' | 'at-mention',
  options?: {
    offset?: number
    limit?: number
  },
): Promise<
  | FileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | AlreadyReadFileAttachment
  | null
> {
  const { offset, limit } = options ?? {}

  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(filename, appState.toolPermissionContext)) {
    return null
  }

  if (
    mode === 'at-mention' &&
    !isFileWithinReadSizeLimit(
      filename,
      getDefaultFileReadingLimits().maxSizeBytes,
    )
  ) {
    const ext = parse(filename).ext.toLowerCase()
    if (!isPDFExtension(ext)) {
      try {
        await getFsImplementation().stat(filename)
        return null
      } catch {
      }
    }
  }

  if (mode === 'at-mention') {
    const pdfRef = await tryGetPDFReference(filename)
    if (pdfRef) {
      return pdfRef
    }
  }

  const existingFileState = toolUseContext.readFileState.get(filename)
  if (existingFileState && mode === 'at-mention') {
    try {
      const mtimeMs = await getFileModificationTimeAsync(filename)

      if (mtimeMs === existingFileState.timestamp) {
        return {
          type: 'already_read_file',
          filename,
          displayPath: relative(getCwd(), filename),
          content: {
            type: 'text',
            file: {
              filePath: filename,
              content: existingFileState.content,
              numLines: countCharInString(existingFileState.content, '\n') + 1,
              startLine: offset ?? 1,
              totalLines:
                countCharInString(existingFileState.content, '\n') + 1,
            },
          },
        }
      }
    } catch {
    }
  }

  try {
    const fileInput = {
      file_path: filename,
      offset,
      limit,
    }

    async function readTruncatedFile(): Promise<
      | FileAttachment
      | CompactFileReferenceAttachment
      | AlreadyReadFileAttachment
      | null
    > {
      if (mode === 'compact') {
        return {
          type: 'compact_file_reference',
          filename,
          displayPath: relative(getCwd(), filename),
        }
      }

      const appState = toolUseContext.getAppState()
      if (isFileReadDenied(filename, appState.toolPermissionContext)) {
        return null
      }

      try {
        const truncatedInput = {
          file_path: filename,
          offset: offset ?? 1,
          limit: MAX_LINES_TO_READ,
        }
        const result = await FileReadTool.call(truncatedInput, toolUseContext)

        return {
          type: 'file' as const,
          filename,
          content: result.data,
          truncated: true,
          displayPath: relative(getCwd(), filename),
        }
      } catch {
        return null
      }
    }

    const isValid = await FileReadTool.validateInput(fileInput, toolUseContext)
    if (!isValid.result) {
      return null
    }

    try {
      const result = await FileReadTool.call(fileInput, toolUseContext)
      return {
        type: 'file',
        filename,
        content: result.data,
        displayPath: relative(getCwd(), filename),
      }
    } catch (error) {
      if (
        error instanceof MaxFileReadTokenExceededError ||
        error instanceof FileTooLargeError
      ) {
        return await readTruncatedFile()
      }
      throw error
    }
  } catch {
    return null
  }
}
