import { stat } from 'node:fs/promises'
import type { ToolUseContext } from '../../kit/tool.js'
import { lineAnchorsEnabled } from '../../engines/change-transaction/lineAnchors.js'
import { isRemotePath } from '../../../platform/remote-file-target/target.js'
import { extractDocumentText } from '../../kit/documentText.js'
import type { ReadFileRangeResult } from '../../../platform/files/readFileInRange.js'
import type { FileReadingLimits } from './fileReadLimits.js'
import { MAX_LINES_TO_READ } from '../../kit/names/fileRead.js'
import { renderArchiveTarget, renderSqliteTarget, type ParsedRichTarget, type RichRender } from '../readRichFormats.js'
import type { FileState } from '../../../platform/files/fileStateCache.js'
import type { Input, OverCapNote, Output, LaneResult, TextFile } from './schema.js'
import { resultLineAnchors, resultPreRenderedBody } from './results.js'
import { MaxFileReadTokenExceededError, overCapNextWords, numberedReadContent, firstWindowUnderCap, tokensOverCap, numberedWindow, windowSpan, cutMark, overCapWords } from './window.js'
import { realLineTotal, shownWindow, inMemoryRangeSlice } from './source.js'
import type { ParsedLineRange } from './target.js'

export async function readRichFormatLane(
  resolvedContainerPath: string,
  rich: ParsedRichTarget,
  input: Input,
  parsedRanges: readonly ParsedLineRange[] | null,
  context: ToolUseContext,
  declared: FileReadingLimits,
  ownRead: boolean,
  reserve: () => FileReadingLimits = () => declared,
  renderingOverride?: RichRender,
): Promise<LaneResult> {
  const stats = await stat(resolvedContainerPath)
  let rendering: RichRender
  if (renderingOverride !== undefined) {
    rendering = renderingOverride
  } else if (rich.kind === 'archive') {
    rendering = await renderArchiveTarget(resolvedContainerPath, rich.ext, rich.subtarget)
  } else if (rich.kind === 'sqlite') {
    rendering = await renderSqliteTarget(resolvedContainerPath, rich.subtarget, isRemotePath(rich.containerPath) ? rich.containerPath : resolvedContainerPath)
  } else {
    rendering = { text: await extractDocumentText(resolvedContainerPath, context.abortController.signal), ownBytes: false }
  }
  const extracted = rendering.text
  const ownBytes = rendering.ownBytes

  const limits = reserve()
  const mtimeMs = stats.mtimeMs
  const totalBytes = Buffer.byteLength(extracted, 'utf8')
  const wholeCounted = inMemoryRangeSlice(extracted, 0, 0, mtimeMs, totalBytes)
  const totalLines = realLineTotal(wholeCounted)
  const anchored = lineAnchorsEnabled() && input.line_anchors === true
  const displayPath = rich.subtarget ? `${resolvedContainerPath}:${rich.subtarget}` : resolvedContainerPath
  const recordRead = (state: FileState): void => {
    if (ownBytes && rich.subtarget !== undefined) context.readFileState.set(displayPath, rendering.sqliteRowIdentity === undefined ? state : { ...state, sqliteRowIdentity: rendering.sqliteRowIdentity })
  }

  if (parsedRanges !== null && parsedRanges.length > 0) {
    const blocks: string[] = []
    const rawPieces: string[] = []
    let totalShownLines = 0
    let firstStartLine = 1
    for (let i = 0; i < parsedRanges.length; i++) {
      const sel = parsedRanges[i]!
      const lineOffset =
        sel.kind === 'tail'
          ? Math.max(0, totalLines - sel.count)
          : Math.max(0, sel.start - 1)
      const maxLines =
        sel.kind === 'tail'
          ? sel.count
          : (sel.limit ?? MAX_LINES_TO_READ)
      const slice = inMemoryRangeSlice(extracted, lineOffset, maxLines, mtimeMs, totalBytes)
      const shown = shownWindow(slice, lineOffset)
      const startLine = lineOffset + 1
      if (i === 0) firstStartLine = startLine
      totalShownLines += shown.count
      rawPieces.push(shown.content)
      const sliceFile: TextFile = {
        filePath: displayPath,
        content: slice.content,
        numLines: shown.count,
        startLine,
        totalLines,
      }
      if (slice.content === '') {
        if (totalLines > 0 && startLine > totalLines) {
          blocks.push(`<system-reminder>Warning: the file exists but is shorter than the requested offset. Read was requested to start at line ${startLine}, but the file has only ${totalLines} ${totalLines === 1 ? 'line' : 'lines'}.</system-reminder>`)
        } else {
          blocks.push('<system-reminder>Warning: the file exists but has empty contents.</system-reminder>')
        }
      } else {
        const numbered = numberedWindow(sliceFile, anchored)
        const mark =
          startLine <= 1 && startLine + shown.count - 1 >= totalLines && parsedRanges.length > 1
            ? `\n[${windowSpan(sliceFile)} of ${totalLines} — the end of the file]`
            : cutMark(sliceFile)
        blocks.push(`${numbered}${mark}`)
      }
    }
    const joinedContent = rawPieces.join('\n')
    let overCap: OverCapNote | undefined
    let combinedRendered = blocks.join('\n\n')
    const tokens = await tokensOverCap(combinedRendered, 'txt', limits.maxTokens, limits.room !== true)
    if (tokens !== undefined) {
      const synthRange: ReadFileRangeResult = {
        content: joinedContent,
        lineCount: totalShownLines,
        totalLines,
        totalBytes,
        readBytes: Buffer.byteLength(joinedContent),
        mtimeMs,
        endsWithNewline: false,
      }
      const window = firstWindowUnderCap(
        synthRange,
        totalShownLines,
        totalLines,
        combinedRendered,
        firstStartLine - 1,
        displayPath,
        'txt',
        limits,
        tokens,
      )
      if (!ownRead || window === null) {
        const next = { offset: firstStartLine, limit: window?.shown.lineCount ?? 1 }
        throw new MaxFileReadTokenExceededError(
          tokens,
          limits.maxTokens,
          `no lines were returned (the file has ${totalLines} ${totalLines === 1 ? 'line' : 'lines'}); ${overCapNextWords(next)}`,
          next,
        )
      }
      overCap = window.note
      combinedRendered = `${overCapWords({
        filePath: displayPath,
        content: window.shown.content,
        numLines: window.shown.lineCount,
        startLine: firstStartLine,
        totalLines,
        overCap,
      })}\n${numberedReadContent(window.shown.content, firstStartLine, anchored)}`
      totalShownLines = window.shown.lineCount
    }
    const data: Output = {
      type: 'text',
      file: {
        filePath: displayPath,
        content: joinedContent || blocks.join('\n'),
        numLines: totalShownLines,
        startLine: firstStartLine,
        totalLines,
        ...(overCap !== undefined ? { overCap } : {}),
      },
    }
    resultPreRenderedBody.set(data, combinedRendered)
    if (anchored && totalShownLines > 0) resultLineAnchors.add(data)
    recordRead({
      content: joinedContent,
      timestamp: Math.floor(mtimeMs),
      offset: firstStartLine,
      limit: totalShownLines,
      isPartialView: parsedRanges.length > 1,
    })
    return { data }
  }

  const rawOffset = input.offset
  let lineOffset = rawOffset !== undefined && rawOffset > 0 ? rawOffset - 1 : 0
  let maxLines = input.limit ?? MAX_LINES_TO_READ
  if (rawOffset !== undefined && rawOffset < 0) {
    const tailCount = Math.abs(rawOffset)
    lineOffset = Math.max(0, totalLines - tailCount)
    maxLines = input.limit !== undefined ? Math.min(input.limit, tailCount) : tailCount
  }

  let range = inMemoryRangeSlice(extracted, lineOffset, maxLines, mtimeMs, totalBytes)
  let overCap: OverCapNote | undefined
  let shown = shownWindow(range, lineOffset)
  const rendered = numberedReadContent(shown.content, lineOffset + 1, anchored)
  const tokens = await tokensOverCap(rendered, 'txt', limits.maxTokens, limits.room !== true)
  if (tokens !== undefined) {
    const window = firstWindowUnderCap(range, shown.count, totalLines, rendered, lineOffset, displayPath, 'txt', limits, tokens)
    if (!ownRead || window === null) {
      const next = { offset: lineOffset + 1, limit: window?.shown.lineCount ?? 1 }
      throw new MaxFileReadTokenExceededError(
        tokens,
        limits.maxTokens,
        `no lines were returned (the file has ${totalLines} ${totalLines === 1 ? 'line' : 'lines'}); ${overCapNextWords(next)}`,
        next,
      )
    }
    range = window.shown
    shown = { content: range.content, count: range.lineCount }
    overCap = window.note
  }

  const data: Output = {
    type: 'text',
    file: {
      filePath: displayPath,
      content: range.content,
      numLines: shown.count,
      startLine: lineOffset + 1,
      totalLines,
      ...(overCap !== undefined ? { overCap } : {}),
    },
  }
  if (anchored && range.content.length > 0) resultLineAnchors.add(data)
  const coveredWholeTarget = lineOffset === 0 && range.lineCount === range.totalLines
  recordRead({
    content: range.content,
    timestamp: Math.floor(mtimeMs),
    offset: coveredWholeTarget ? 0 : lineOffset + 1,
    limit: coveredWholeTarget ? undefined : range.lineCount,
  })
  return { data }
}
