import { stat } from 'node:fs/promises'
import { closeSync, readSync } from 'node:fs'
import type { ToolUseContext } from '../../kit/tool.js'
import { anchorPatchEnabled } from '../../engines/change-transaction/anchorPatch.js'
import { staleEditRecoveryEnabled } from '../../engines/change-transaction/stalePatchRecovery.js'
import { changeTransactionEnabled } from '../../engines/change-transaction/contracts.js'
import { lineAnchorsEnabled } from '../../engines/change-transaction/lineAnchors.js'
import { fileGeneration, recordDisplayedLines } from '../../engines/change-transaction/seenLines.js'
import { rememberAnchoredSnapshot } from '../../engines/change-transaction/snapshotRing.js'
import { mintFileAnchor } from '../../engines/change-transaction/snapshotAnchor.js'
import { ownerFromToolUseContext } from '../../../engine/run-owner/resolveOwner.js'
import { ideReadTextAvailable } from '../../../integrations/acp/ideToolBridge.js'
import { isRemotePath } from '../../../platform/remote-file-target/target.js'
import { readFileInRange, type ReadFileRangeResult } from '../../../platform/files/readFileInRange.js'
import { openRegularFileSync } from '../regularFile.js'
import type { FileReadingLimits } from './fileReadLimits.js'
import { MAX_LINES_TO_READ } from '../../kit/names/read.js'
import type { Input, OverCapNote, Output, LaneResult, TextFile } from './schema.js'
import { resultLineAnchors, resultPreRenderedBody, notifyFileReadListeners } from './results.js'
import { MaxFileReadTokenExceededError, overCapNextWords, MAX_DISPLAY_LINE_CHARS, numberedReadContent, firstWindowUnderCap, tokensOverCap, numberedWindow, windowSpan, cutMark, overCapWords } from './window.js'
import { UTF16_BE_REFUSAL, readsElsewhere, readRangeElsewhere, noteRemoteRead, realLineTotal, shownWindow, readTailLinesReverse } from './source.js'
import type { ParsedLineRange } from './target.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export async function readMultiRangeTextLane(
  resolvedPath: string,
  keyPath: string,
  input: Input,
  parsedRanges: readonly ParsedLineRange[],
  ext: string,
  context: ToolUseContext,
  declared: FileReadingLimits,
  ownRead: boolean,
  reserve: () => FileReadingLimits = () => declared,
): Promise<LaneResult> {
  const bom = Buffer.alloc(2)
  if (!isRemotePath(resolvedPath)) {
    try {
      const { fd } = openRegularFileSync(resolvedPath)
      try {
        readSync(fd, bom, 0, 2, 0)
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      passedOver(error)
    }
    if (bom[0] === 0xfe && bom[1] === 0xff) throw new Error(UTF16_BE_REFUSAL)
  }
  const remoteHead = isRemotePath(resolvedPath) ? await readRangeElsewhere(resolvedPath, 0, 0, undefined, context.abortController.signal) : null
  const st = remoteHead !== null ? { size: remoteHead.totalBytes, mtimeMs: remoteHead.mtimeMs } : ideReadTextAvailable() ? { size: 0, mtimeMs: Date.now() } : await stat(resolvedPath)
  const useFastReverse = !readsElsewhere(resolvedPath) && st.size > 2 * 1024 * 1024 && parsedRanges.every(r => r.kind === 'tail') && !(bom[0] === 0xff && bom[1] === 0xfe)
  const wholeLines = (remoteHead === null && ideReadTextAvailable()) || st.size <= declared.maxSizeBytes ? undefined : 0
  const counted = useFastReverse
    ? null
    : (await readRangeElsewhere(resolvedPath, 0, wholeLines, undefined, context.abortController.signal)) ??
      (await readFileInRange(resolvedPath, 0, wholeLines, undefined, context.abortController.signal))
  let totalLines = counted !== null ? realLineTotal(counted) : 0
  const anchor = counted !== null && wholeLines === undefined && changeTransactionEnabled() ? mintFileAnchor(counted.content) : undefined
  const anchored = lineAnchorsEnabled() && input.line_anchors === true
  const blocks: string[] = []
  const rawPieces: string[] = []
  let totalShownLines = 0
  let firstStartLine = 1
  const owner = ownerFromToolUseContext(context)
  const generation = fileGeneration(resolvedPath)
  const displayed: { start: number; content: string }[] = []

  for (let i = 0; i < parsedRanges.length; i++) {
    const sel = parsedRanges[i]!
    let slice: ReadFileRangeResult
    let lineOffset: number
    if (sel.kind === 'tail' && useFastReverse) {
      slice = readTailLinesReverse(resolvedPath, sel.count, sel.count)
      totalLines = realLineTotal(slice)
      lineOffset = Math.max(0, totalLines - sel.count)
    } else {
      lineOffset =
        sel.kind === 'tail'
          ? Math.max(0, totalLines - sel.count)
          : Math.max(0, sel.start - 1)
      const maxLines =
        sel.kind === 'tail'
          ? sel.count
          : (sel.limit ?? MAX_LINES_TO_READ)
      slice =
        (await readRangeElsewhere(resolvedPath, lineOffset, maxLines, undefined, context.abortController.signal)) ??
        (await readFileInRange(resolvedPath, lineOffset, maxLines, undefined, context.abortController.signal))
    }
    const shown = shownWindow(slice, lineOffset)
    const startLine = lineOffset + 1
    if (i === 0) firstStartLine = startLine
    totalShownLines += shown.count
    rawPieces.push(shown.content)
    const sliceFile: TextFile = {
      filePath: resolvedPath,
      content: slice.content,
      numLines: shown.count,
      startLine,
      totalLines,
      ...(input.lossless ? { lossless: true } : {}),
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
      if (shown.count > 0) displayed.push({ start: startLine, content: shown.content })
    }
  }

  const joinedContent = rawPieces.join('\n')
  const limits = reserve()
  let overCap: OverCapNote | undefined
  let combinedRendered = blocks.join('\n\n')
  const tokens = await tokensOverCap(combinedRendered, ext, limits.maxTokens, limits.room !== true)
  if (tokens !== undefined) {
    if (input.lossless) throw new Error(`Lossless read exceeds the ${limits.maxTokens}-token budget; narrow the range (a single line cannot be split).`)
    const synthRange: ReadFileRangeResult = {
      content: joinedContent,
      lineCount: totalShownLines,
      totalLines,
      totalBytes: st.size,
      readBytes: Buffer.byteLength(joinedContent),
      mtimeMs: st.mtimeMs,
      endsWithNewline: false,
    }
    const window = firstWindowUnderCap(
      synthRange,
      totalShownLines,
      totalLines,
      combinedRendered,
      firstStartLine - 1,
      resolvedPath,
      ext,
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
      filePath: resolvedPath,
      content: window.shown.content,
      numLines: window.shown.lineCount,
      startLine: firstStartLine,
      totalLines,
      overCap,
    })}\n${numberedReadContent(window.shown.content, firstStartLine, anchored, input.lossless)}`
    totalShownLines = window.shown.lineCount
  }
  if (generation !== null && overCap === undefined) {
    for (const shown of displayed) recordDisplayedLines(owner, resolvedPath, generation, shown.start, shown.content, input.lossless ? Infinity : MAX_DISPLAY_LINE_CHARS)
  }
  context.readFileState.set(keyPath, {
    content: joinedContent,
    timestamp: Math.floor(st.mtimeMs),
    offset: firstStartLine,
    limit: totalShownLines,
    isPartialView: parsedRanges.length > 1,
  })
  noteRemoteRead(context, keyPath)
  if (!isRemotePath(keyPath)) context.nestedMemoryAttachmentTriggers?.add(keyPath)
  notifyFileReadListeners(resolvedPath, joinedContent)

  const data: Output = {
    type: 'text',
    file: {
      filePath: resolvedPath,
      content: joinedContent || blocks.join('\n'),
      numLines: totalShownLines,
      startLine: firstStartLine,
      totalLines,
      ...(anchor !== undefined ? { anchor } : {}),
      ...(overCap !== undefined ? { overCap } : {}),
    },
  }
  resultPreRenderedBody.set(data, combinedRendered)
  if (anchored && totalShownLines > 0) {
    resultLineAnchors.add(data)
  }
  if (anchor !== undefined && counted !== null && (anchorPatchEnabled() || staleEditRecoveryEnabled())) rememberAnchoredSnapshot(owner, anchor, counted.content, resolvedPath)
  return { data }
}
