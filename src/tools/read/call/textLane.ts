import { stat } from 'node:fs/promises'
import { closeSync, readSync } from 'node:fs'
import type { ToolUseContext } from '../../kit/tool.js'
import { anchorPatchEnabled } from '../../engines/change-transaction/anchorPatch.js'
import { staleEditRecoveryEnabled } from '../../engines/change-transaction/stalePatchRecovery.js'
import { changeTransactionEnabled } from '../../engines/change-transaction/contracts.js'
import { lineAnchorsEnabled } from '../../engines/change-transaction/lineAnchors.js'
import { fileGeneration, recordDisplayedLines } from '../../engines/change-transaction/seenLines.js'
import { rememberAnchoredSnapshot } from '../../engines/change-transaction/snapshotRing.js'
import { mintFileAnchor, mintRangeAnchor } from '../../engines/change-transaction/snapshotAnchor.js'
import { ownerFromToolUseContext } from '../../../engine/run-owner/resolveOwner.js'
import { isRemotePath } from '../../../platform/remote-file-target/target.js'
import { isMnemeFile } from '../../../sessions/memory-shapes/memoryFileDetection.js'
import { FileTooLargeError, readFileInRange, type ReadFileRangeResult } from '../../../platform/files/readFileInRange.js'
import { openRegularFileSync } from '../regularFile.js'
import type { FileReadingLimits } from './fileReadLimits.js'
import { buildOutlineNumberedWindow } from '../outline.js'
import { MAX_LINES_TO_READ } from '../../kit/names/read.js'
import type { Input, OverCapNote, Output, LaneResult } from './schema.js'
import { resultLineAnchors, resultOutlineBodies, notifyFileReadListeners } from './results.js'
import { MaxFileReadTokenExceededError, overCapNextWords, MAX_DISPLAY_LINE_CHARS, numberedReadContent, firstWindowUnderCap, tokensOverCap } from './window.js'
import { UTF16_BE_REFUSAL, readsElsewhere, readRangeElsewhere, noteRemoteRead, realLineTotal, shownWindow, countedSizeRefusal, readTailLinesReverse } from './source.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export async function readTextLane(
  resolvedPath: string,
  keyPath: string,
  input: Input,
  ext: string,
  context: ToolUseContext,
  declared: FileReadingLimits,
  ownRead = false,
  reserve: () => FileReadingLimits = () => declared,
): Promise<LaneResult> {
  const rawOffset = input.offset
  let lineOffset = rawOffset !== undefined && rawOffset > 0 ? rawOffset - 1 : 0
  let maxLines = input.limit ?? MAX_LINES_TO_READ
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
  let range: ReadFileRangeResult
  const ideRange = readsElsewhere(resolvedPath)
    ? await (async () => {
        if (rawOffset !== undefined && rawOffset < 0) {
          const tailCount = Math.abs(rawOffset)
          const counted = await readRangeElsewhere(resolvedPath, 0, 0, undefined, context.abortController.signal)
          if (counted === null) return null
          const total = realLineTotal(counted)
          lineOffset = Math.max(0, total - tailCount)
          maxLines = input.limit !== undefined ? Math.min(input.limit, tailCount) : tailCount
          return readRangeElsewhere(resolvedPath, lineOffset, maxLines, undefined, context.abortController.signal)
        }
        const maxBytes = input.limit === undefined ? declared.maxSizeBytes : undefined
        return readRangeElsewhere(resolvedPath, lineOffset, maxLines, maxBytes, context.abortController.signal)
      })()
    : null
  if (ideRange !== null) {
    range = ideRange
  } else if (rawOffset !== undefined && rawOffset < 0) {
    const tailCount = Math.abs(rawOffset)
    const st = await stat(resolvedPath)
    if (st.size > 2 * 1024 * 1024 && !(bom[0] === 0xff && bom[1] === 0xfe)) {
      range = readTailLinesReverse(resolvedPath, tailCount, input.limit)
      const total = realLineTotal(range)
      lineOffset = Math.max(0, total - tailCount)
    } else {
      const counted = await readFileInRange(resolvedPath, 0, 0, undefined, context.abortController.signal)
      const total = realLineTotal(counted)
      lineOffset = Math.max(0, total - tailCount)
      maxLines = input.limit !== undefined ? Math.min(input.limit, tailCount) : tailCount
      range = await readFileInRange(resolvedPath, lineOffset, maxLines, undefined, context.abortController.signal)
    }
  } else {
    const maxBytes = input.limit === undefined ? declared.maxSizeBytes : undefined
    try {
      range = await readFileInRange(
        resolvedPath,
        lineOffset,
        maxLines,
        maxBytes,
        context.abortController.signal,
      )
    } catch (err) {
      if (!(err instanceof FileTooLargeError) || !ownRead || input.limit !== undefined) throw err
      throw await countedSizeRefusal(err, resolvedPath, context.abortController.signal)
    }
  }
  const limits = reserve()
  let overCap: OverCapNote | undefined
  const totalLines = realLineTotal(range)
  let shown = shownWindow(range, lineOffset)
  const anchored = lineAnchorsEnabled() && input.line_anchors === true
  const outlineBody =
    input.outline === true
      ? await buildOutlineNumberedWindow(resolvedPath, shown.content, lineOffset + 1, shown.count, totalLines, anchored)
      : null
  const rendered = outlineBody ?? numberedReadContent(shown.content, lineOffset + 1, anchored, input.lossless)
  const tokens = await tokensOverCap(rendered, ext, limits.maxTokens, limits.room !== true)
  if (tokens !== undefined) {
    if (input.lossless) throw new Error(`Lossless read exceeds the ${limits.maxTokens}-token budget; narrow the range (a single line cannot be split).`)
    const window = firstWindowUnderCap(range, shown.count, totalLines, rendered, lineOffset, resolvedPath, ext, limits, tokens)
    if (!ownRead || window === null) {
      const next = { offset: lineOffset + 1, limit: window?.shown.lineCount ?? 1 }
      throw new MaxFileReadTokenExceededError(
        tokens,
        limits.maxTokens,
        `no lines were returned (the file has ${totalLines} ${totalLines === 1 ? 'line' : 'lines'}); ${overCapNextWords(next)}${window === null ? ' A single line exceeds the cap; offset and limit cannot split it, so search for the needed content instead of repeating that Read.' : ''}`,
        next,
      )
    }
    range = window.shown
    shown = { content: range.content, count: range.lineCount }
    overCap = window.note
  }

  const coveredWholeFile =
    outlineBody === null &&
    lineOffset === 0 &&
    range.lineCount === range.totalLines &&
    range.readBytes === range.totalBytes
  const existingState = context.readFileState.get(keyPath)
  const preserveExistingFullRead =
    outlineBody !== null &&
    existingState !== undefined &&
    !existingState.isPartialView &&
    existingState.timestamp === Math.floor(range.mtimeMs)
  if (!preserveExistingFullRead) {
    context.readFileState.set(keyPath, {
      content: range.content,
      timestamp: Math.floor(range.mtimeMs),
      offset: coveredWholeFile ? 0 : overCap !== undefined || (rawOffset !== undefined && rawOffset < 0) ? lineOffset + 1 : (input.offset ?? 0),
      limit: coveredWholeFile ? undefined : overCap !== undefined ? range.lineCount : (rawOffset !== undefined && rawOffset < 0 ? shown.count : input.limit),
      ...(outlineBody !== null ? { isPartialView: true } : {}),
    })
    noteRemoteRead(context, keyPath, outlineBody === null && lineOffset === 0 && range.lineCount === range.totalLines)
  }
  if (!isRemotePath(keyPath)) context.nestedMemoryAttachmentTriggers?.add(keyPath)
  notifyFileReadListeners(resolvedPath, range.content)

  const memoryUpdatedAt = isMnemeFile(resolvedPath) ? Math.floor(range.mtimeMs) : undefined
  let anchor: string | undefined
  let anchoredContent = range.content
  if (
    outlineBody === null &&
    changeTransactionEnabled() &&
    (coveredWholeFile || (range.content.length > 0 && shown.count > 0))
  ) {
    const wholeFile =
      lineOffset === 0 &&
      range.lineCount === range.totalLines &&
      range.readBytes === range.totalBytes
    if (!wholeFile) anchoredContent = shown.content
    anchor = wholeFile
      ? mintFileAnchor(range.content)
      : mintRangeAnchor(shown.content, lineOffset + 1, shown.count)
  }
  const data: Output = {
    type: 'text',
    file: {
      filePath: resolvedPath,
      content: range.content,
      numLines: shown.count,
      startLine: lineOffset + 1,
      totalLines,
      ...(input.lossless ? { lossless: true } : {}),
      ...(anchor !== undefined ? { anchor } : {}),
      ...(memoryUpdatedAt !== undefined ? { memoryUpdatedAt } : {}),
      ...(overCap !== undefined ? { overCap } : {}),
    },
  }

  if (anchored && range.content.length > 0) {
    resultLineAnchors.add(data)
  }
  if (outlineBody !== null) {
    resultOutlineBodies.set(data, outlineBody)
  }
  if (outlineBody === null && shown.count > 0) {
    const owner = ownerFromToolUseContext(context)
    const generation = fileGeneration(resolvedPath)
    if (generation !== null) recordDisplayedLines(owner, resolvedPath, generation, lineOffset + 1, shown.content, input.lossless ? Infinity : MAX_DISPLAY_LINE_CHARS)
    if (anchor !== undefined && (anchorPatchEnabled() || staleEditRecoveryEnabled())) rememberAnchoredSnapshot(owner, anchor, anchoredContent, resolvedPath)
  }
  return { data }
}
