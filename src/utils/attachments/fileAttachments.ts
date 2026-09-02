// File attachments — mid-session change detection (getChangedFiles: the
// ENOENT-only eviction rule, PR #18525), the large-PDF reference path, and
// the shared file-read core for @-mentions and post-compact restoration.
// Owned Mercury module.

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

      // Partial reads have no sound diff baseline (the stored content is a
      // window, not the file) — change detection covers full reads only.
      if (fileState.offset !== undefined || fileState.limit !== undefined) {
        return null
      }

      const normalizedPath = expandPath(filePath)

      // Deny-ruled files are invisible to change detection too — a rule
      // that blocks reading blocks re-reading.
      if (isFileReadDenied(normalizedPath, appState.toolPermissionContext)) {
        return null
      }

      try {
        const mtime = await getFileModificationTimeAsync(normalizedPath)
        if (mtime <= fileState.timestamp) {
          return null
        }

        const fileInput = { file_path: normalizedPath }

        // The read tool's own validation decides readability.
        const isValid = await FileReadTool.validateInput(
          fileInput,
          toolUseContext,
        )
        if (!isValid.result) {
          return null
        }

        const result = await FileReadTool.call(fileInput, toolUseContext)
        // Text files attach only the changed region, not the whole file.
        if (result.data.type === 'text') {
          const snippet = getSnippetForTwoFileDiff(
            fileState.content,
            result.data.file.content,
          )

          // mtime moved but bytes did not (touch, save-without-change).
          if (snippet === '') {
            return null
          }

          return {
            type: 'edited_text_file' as const,
            filename: normalizedPath,
            snippet,
          }
        }

        // Images re-attach whole, under the same token budget the read
        // tool itself enforces.
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

        // Notebooks, PDFs, and multi-part reads have no diff story; the
        // explicit null keeps this map callback total.
        return null
      } catch (err) {
        // The eviction bar is ENOENT and nothing else — only a truly
        // deleted file leaves the cache. Every transient failure class
        // (the tmp→rename window of an editor's atomic save, EACCES
        // churn, a network-FS hiccup) keeps the entry: evicting on those
        // makes the very next Edit fail code-6 against a file that
        // exists and was just read, a race editor auto-save/format-on-
        // save regimes hit constantly (the PR #18525 regression class).
        if (isENOENT(err)) {
          toolUseContext.readFileState.delete(filePath)
        }
        return null
      }
    }),
  )
  return results.filter(result => result != null) as Attachment[]
}

/**
 * Large PDFs attach as a reference card, never inline: over the page
 * threshold, the operator gets a pdf_reference (page count + size) and the
 * model reads pages on demand. Null means inline normally.
 */
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
    // A real page count when the parser produced one; else bytes stand in
    // at roughly 100KB per page.
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
    // Unstattable ⇒ no reference; the normal read path will tell the truth.
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

  // Deny rules end the attempt before any bytes move.
  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(filename, appState.toolPermissionContext)) {
    return null
  }

  // Oversized non-PDF @-mentions stop here (PDFs carry their own size/page
  // story below).
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
        // stat is the existence check: a real oversized file attaches
        // nothing; a missing one falls through and fails honestly in the
        // normal read below.
        await getFsImplementation().stat(filename)
        return null
      } catch {
        // Fall through to the normal read.
      }
    }
  }

  if (mode === 'at-mention') {
    const pdfRef = await tryGetPDFReference(filename)
    if (pdfRef) {
      return pdfRef
    }
  }

  // An @-mention of a file the context already holds, unchanged, should
  // not re-ship its bytes to the API.
  const existingFileState = toolUseContext.readFileState.get(filename)
  if (existingFileState && mode === 'at-mention') {
    try {
      const mtimeMs = await getFileModificationTimeAsync(filename)

      // The stored timestamp has two possible meanings — FileReadTool
      // stores Date.now() at read time, FileEdit/Write store the file's
      // real mtime — so only an EXACT match with the current mtime proves
      // both that the writer recorded a true mtime and that the file has
      // not moved since. (`<=` alone would trust Date.now() stamps it
      // cannot actually compare.)
      if (mtimeMs === existingFileState.timestamp) {
        // already_read_file = "in context, skip the wire".
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
      // No stat, no shortcut — the ordinary read below decides.
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

      // Deny rules re-check here — the truncated lane is still a read.
      const appState = toolUseContext.getAppState()
      if (isFileReadDenied(filename, appState.toolPermissionContext)) {
        return null
      }

      try {
        // Too big whole ⇒ the head has to do: first MAX_LINES_TO_READ lines.
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

    // The read tool's own validation decides readability.
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
