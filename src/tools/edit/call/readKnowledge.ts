import type { ToolUseContext } from '../../kit/tool.js'
import { rememberAnchoredSnapshot } from '../../engines/change-transaction/snapshotRing.js'
import { columnCutsOf, losslessReadCall, fileGeneration, recordLinesWritten, recordSeenLines, seenLinesOf, lineCountOfText as lineCountOf } from '../../engines/change-transaction/seenLines.js'
import { checkAnchor, formatAnchorFailure } from '../../engines/change-transaction/snapshotAnchor.js'
import { ownerFromToolUseContext } from '../../../engine/run-owner/resolveOwner.js'
import { needsPowerShellBom } from '../../../platform/files/file.js'
import { plural } from '../../../platform/text/strings.js'
import type { FileState } from '../../../platform/files/fileStateCache.js'
import { MAX_LINES_TO_READ } from '../../kit/names/read.js'
import { otherLiveSessionsClause, UNREAD_EXISTING_FILE_NOTE } from '../otherSession.js'
import { findActualString } from './editMatching.js'
import { noMatchHint } from '../editResult.js'
import { READ_THROUGH_MARGIN, coalesceLineRanges, linesOutside, planReadThrough, renderCarriedWindows, spellLineRanges, widenLineRanges, type CarriedWindow, type LineRange, type ReadThroughPlan } from '../readThrough.js'
import type { StructuredPatchHunk } from '../../../platform/text/diff.js'
import { isFullReadEntry, hasText, splitLeadingBom } from './fileFacts.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export function linesOfMatches(content: string, oldString: string, replaceAll: boolean): { start: number; end: number }[] | null {
  const actual = findActualString(content, oldString)
  if (actual === null || actual.length === 0) return null
  const ranges: { start: number; end: number }[] = []
  const height = actual.split('\n').length - 1
  const lastLine = lineCountOf(content)
  let from = 0
  let line = 1
  for (let at = content.indexOf(actual); at !== -1; at = content.indexOf(actual, from)) {
    line += content.slice(from, at).split('\n').length - 1
    ranges.push({ start: line, end: Math.min(line + height, lastLine) })
    if (!replaceAll) break
    line += height
    from = at + actual.length
  }
  return ranges
}

export function readCoversRanges(entry: FileState, ranges: { start: number; end: number }[] | null): boolean {
  if (entry.isPartialView) return false
  if (isFullReadEntry(entry)) return true
  const start = Math.max(1, entry.offset ?? 1)
  const count = Math.min(entry.limit ?? MAX_LINES_TO_READ, entry.content.split('\n').length)
  return ranges !== null && ranges.every(range => range.start >= start && range.end < start + count)
}

const READ_RANGES_NAMED = 5

type Carry = { windows: CarriedWindow[]; ranges: LineRange[]; rest: LineRange[]; generation: string }

function planCarry(content: string, expandedPath: string, gaps: readonly LineRange[]): ReadThroughPlan {
  return planReadThrough(content, widenLineRanges(gaps, READ_THROUGH_MARGIN, lineCountOf(content)), expandedPath)
}

function planUnreadLines(
  expandedPath: string,
  currentContent: string,
  gaps: readonly LineRange[],
  generationAtRead: string | null,
): Carry | null {
  if (generationAtRead === null || fileGeneration(expandedPath) !== generationAtRead) return null
  const plan = planCarry(currentContent, expandedPath, gaps)
  if (plan.windows.length === 0) return null
  const ranges = plan.windows.map(window => ({ start: window.start, end: window.end }))
  return { windows: plan.windows, ranges, rest: linesOutside(gaps, ranges), generation: generationAtRead }
}

export function recordCarry(
  owner: ReturnType<typeof ownerFromToolUseContext>,
  expandedPath: string,
  generation: string,
  windows: readonly CarriedWindow[],
): void {
  for (const window of windows) {
    recordSeenLines(owner, expandedPath, generation, window.start, window.end - window.start + 1)
    rememberAnchoredSnapshot(owner, window.anchor, window.content, expandedPath)
  }
}

export function postLineAtOrAfter(line: number, hunks: readonly StructuredPatchHunk[]): number {
  let delta = 0
  for (const hunk of hunks) {
    if (line < hunk.oldStart) return line + delta
    if (line >= hunk.oldStart + hunk.oldLines) {
      delta = hunk.newStart + hunk.newLines - (hunk.oldStart + hunk.oldLines)
      continue
    }
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const text of hunk.lines) {
      const mark = text[0]
      if (mark === '+') {
        newLine++
      } else if (mark === ' ' || mark === '-') {
        if (oldLine === line) return newLine
        oldLine++
        if (mark === ' ') newLine++
      }
    }
    return newLine
  }
  return line + delta
}

function mapRangesThroughPatch(ranges: readonly LineRange[], hunks: readonly StructuredPatchHunk[], lastLine: number): LineRange[] {
  const clamp = (n: number): number => Math.max(1, Math.min(n, lastLine))
  return coalesceLineRanges(
    ranges.map(range => {
      const start = postLineAtOrAfter(range.start, hunks)
      const end = postLineAtOrAfter(range.end + 1, hunks) - 1
      return end < start ? { start: clamp(start), end: clamp(start) } : { start: clamp(start), end: clamp(end) }
    }),
  )
}

function authoredLinesOf(hunks: readonly StructuredPatchHunk[]): LineRange[] {
  const ranges: LineRange[] = []
  for (const hunk of hunks) {
    let newLine = hunk.newStart
    for (const text of hunk.lines) {
      const mark = text[0]
      if (mark === '+') {
        const last = ranges[ranges.length - 1]
        if (last !== undefined && last.end === newLine - 1) last.end = newLine
        else ranges.push({ start: newLine, end: newLine })
        newLine++
      } else if (mark === ' ') {
        newLine++
      }
    }
  }
  return ranges
}

export function knowledgeBeforeWrite(
  context: ToolUseContext,
  expandedPath: string,
  displayPath: string,
  content: string,
  expectedAnchor: string | undefined,
  generation: string | null,
  ledger: ReturnType<typeof seenLinesOf>,
): LineRange[] {
  const lastLine = lineCountOf(content)
  if (lastLine === 0) return []
  const read = readLinesOf(context.readFileState.get(expandedPath), content, true, generation, ledger)
  const ranges = [...read.ranges]
  if (hasText(expectedAnchor) && checkAnchor(expectedAnchor, content, displayPath).ok) {
    const window = expectedAnchor.startsWith('fa:') ? { start: 1, end: lastLine } : rangeAnchorWindow(expectedAnchor)
    if (window !== null) ranges.push(window)
  }
  return coalesceLineRanges(ranges)
}

export function noMatchWords(
  context: ToolUseContext,
  expandedPath: string,
  displayPath: string,
  currentContent: string,
  expectedAnchor: string | undefined,
  oldString: string,
  newString: string,
): string {
  try {
    const owner = ownerFromToolUseContext(context)
    const read = knowledgeBeforeWrite(context, expandedPath, displayPath, currentContent, expectedAnchor, fileGeneration(expandedPath), seenLinesOf(owner, expandedPath))
    const hint = noMatchHint({ content: currentContent, oldString, newString, read, path: expandedPath })
    return hint === '' ? '' : `\n${hint}`
  } catch (error) {
    passedOver(error)
    return ''
  }
}

export function writtenBytesOf(expandedPath: string, content: string, encoding: BufferEncoding): Buffer {
  const marked = needsPowerShellBom(expandedPath) && encoding === 'utf8' && !content.startsWith('\uFEFF') ? `\uFEFF${content}` : content
  return Buffer.from(marked, encoding)
}

export function stampOwnEditAsSeen(
  owner: ReturnType<typeof ownerFromToolUseContext>,
  expandedPath: string,
  generation: string | null,
  known: readonly LineRange[],
  patch: readonly StructuredPatchHunk[],
  updatedFile: string,
): void {
  if (generation === null) return
  const lastLine = Math.max(1, lineCountOf(updatedFile))
  const shifted = patch.length === 0 ? [...known] : mapRangesThroughPatch(known, patch, lastLine)
  const authored = authoredLinesOf(patch)
  for (const range of coalesceLineRanges([...shifted, ...authored])) {
    recordSeenLines(owner, expandedPath, generation, range.start, range.end - range.start + 1)
  }
  recordLinesWritten(owner, expandedPath, generation, authored)
}

type SameCallReadThrough = { text: string; sentence: string; ranges: LineRange[] }

export function sameCallReadThrough(gaps: readonly LineRange[], before: string, after: string, patch: readonly StructuredPatchHunk[], expandedPath: string): SameCallReadThrough {
  const oneGap = gaps.length === 1 && gaps[0]!.start === gaps[0]!.end
  const unread = `${oneGap ? 'Line' : 'Lines'} ${spellLineRanges(gaps)} did not count as read before this edit`
  const mapped = after === before ? [...gaps] : mapRangesThroughPatch(gaps, patch, Math.max(1, lineCountOf(after)))
  const plan = planCarry(after, expandedPath, mapped)
  if (plan.windows.length === 0) return { text: `${unread}.`, sentence: `${unread}.`, ranges: [] }
  const shown = plan.windows.map(window => ({ start: window.start, end: window.end }))
  const one = shown.length === 1 && shown[0]!.start === shown[0]!.end
  const sentence = `${unread}; ${one ? 'line' : 'lines'} ${spellLineRanges(shown)} as ${one ? 'it stands' : 'they stand'} now ${one ? 'is' : 'are'} below, numbered with ${one ? 'its' : 'their'} anchor, and ${one ? 'counts' : 'count'} as read:`
  return { text: `${sentence}\n\n${renderCarriedWindows(plan.windows)}`, sentence, ranges: shown }
}

type ReadLines = { ranges: LineRange[]; recorded: LineRange[]; ledger: LineRange[]; earlier: boolean; attachmentOnly: boolean; separate?: boolean }

function readLinesOf(entry: FileState | undefined, currentContent: string, includeRead: boolean, generation: string | null, ledger: ReturnType<typeof seenLinesOf>): ReadLines {
  const ranges: LineRange[] = []
  const currentBody = splitLeadingBom(currentContent).body
  let earlier = false
  let attachmentOnly = false
  if (includeRead && entry !== undefined) {
    if (entry.isPartialView) {
      attachmentOnly = true
    } else {
      const count = lineCountOf(entry.content)
      if (isFullReadEntry(entry)) {
        if (entry.content === currentBody && count > 0) ranges.push({ start: 1, end: count })
        else earlier = true
      } else if (count > 0) {
        const start = Math.max(1, entry.offset ?? 1)
        const currentWindow = currentBody.split('\n').slice(start - 1, start - 1 + count).join('\n')
        if (currentWindow === entry.content) ranges.push({ start, end: start + count - 1 })
        else earlier = true
      }
    }
  }
  const recorded = [...ranges]
  const currentLedger = generation !== null && ledger?.generation === generation ? [...ledger.ranges] : []
  if (ledger !== undefined && ledger.ranges.length > 0 && currentLedger.length === 0) earlier = true
  ranges.push(...currentLedger)
  return { ranges: coalesceLineRanges(ranges), recorded, ledger: currentLedger, earlier, attachmentOnly }
}

function readKnowledgeWords(displayPath: string, read: ReadLines, addressed: LineRange[] | null, missing: string): string {
  const named = read.ranges.slice(0, READ_RANGES_NAMED)
  const rest = read.ranges.length - named.length
  let reads: string
  if (read.separate) {
    reads = `Current owner ledger for ${displayPath}: ${spellLineRanges(read.ledger)}; a separate Read showed ${spellLineRanges(read.recorded)}, but neither source covers the whole edit`
  } else if (read.ranges.length > 0) {
    reads = `Lines of ${displayPath} read this session: ${spellLineRanges(named)}${rest > 0 ? ` (and ${rest} more ${plural(rest, 'range')})` : ''}`
    if (read.earlier) reads += ', plus a read of the file before it last changed'
  } else if (read.earlier) {
    return `The lines of ${displayPath} read this session were of the file before it last changed — a Read of the file shows what stands.`
  } else if (read.attachmentOnly) {
    return `No lines of ${displayPath} were read this session (an automatic attachment showed part of it, which is not a read) — a Read of the file shows what stands.`
  } else {
    return `No lines of ${displayPath} were read this session — a Read of the file shows what stands.`
  }
  if (addressed === null || addressed.length === 0) {
    return `${reads}; ${missing}, so the lines the edit touches are unknown — a Read of the file shows what stands.`
  }
  const one = addressed.length === 1 && addressed[0]!.start === addressed[0]!.end
  const touches = `the edit touches ${one ? 'line' : 'lines'} ${spellLineRanges(addressed)}`
  const gaps = linesOutside(addressed, read.ranges)
  const first = gaps[0] ?? addressed[0]!
  const covers =
    gaps.length === 0
      ? 'shows them in one read'
      : read.ranges.length === 0
        ? 'covers them'
        : gaps.length === 1
          ? 'covers the gap'
          : `covers the first gap (unread: ${spellLineRanges(gaps)})`
  return `${reads}; ${touches} — Read(offset: ${first.start}, limit: ${first.end - first.start + 1}) ${covers}.`
}

export type ReadKnowledge =
  | { verdict: 'known' }
  | { verdict: 'refused'; message: string; unread: boolean }
  | { verdict: 'carry'; gaps: LineRange[]; carry: Carry }

export function clippedReadRefusal(context: ToolUseContext, path: string, displayPath: string, content: string, touched: readonly LineRange[] | null, oldString?: string): string | null {
  const cuts = columnCutsOf(ownerFromToolUseContext(context), path, fileGeneration(path))
  if (cuts.length === 0 || touched === null) return null
  const lines = content.split('\n')
  for (const cut of cuts) {
    if (!touched.some(range => range.start <= cut.line && range.end >= cut.line)) continue
    if (oldString !== undefined && oldString !== '') {
      const start = lines.slice(0, cut.line - 1).reduce((n, line) => n + line.length + 1, 0)
      const hiddenStart = start + cut.visibleChars
      const hiddenEnd = start + (lines[cut.line - 1]?.length ?? 0)
      let overlaps = false
      for (let at = content.indexOf(oldString); at >= 0; at = content.indexOf(oldString, at + oldString.length)) {
        if (at < hiddenEnd && at + oldString.length > hiddenStart) { overlaps = true; break }
      }
      if (!overlaps) continue
    }
    return `Line ${cut.line} was clipped; ${losslessReadCall(displayPath, cut.line)} shows it before replacement.`
  }
  return null
}

const READ_NEED = 'a prior read of the current content (a Read of the lines it touches, or expected_anchor from a full Read of the file as it stands)'

export function readKnowledge(
  context: ToolUseContext,
  expandedPath: string,
  displayPath: string,
  currentContent: string,
  expectedAnchor: string | undefined,
  touched: { start: number; end: number }[] | null,
  includeRead: boolean | 'content' = true,
  named?: { lines: LineRange[] | null; missing: string; hunks?: boolean },
  carry?: { generation: string | null; oldString?: string },
): ReadKnowledge {
  const clipped = clippedReadRefusal(context, expandedPath, displayPath, currentContent, touched, carry?.oldString)
  if (clipped !== null) return { verdict: 'refused', message: clipped, unread: false }
  const entry = context.readFileState.get(expandedPath)
  if (includeRead === true && entry !== undefined && readCoversRanges(entry, touched)) return { verdict: 'known' }
  const anchor = hasText(expectedAnchor) ? checkAnchor(expectedAnchor, currentContent, displayPath) : null
  if (expectedAnchor?.startsWith('fa:') && anchor?.ok) return { verdict: 'known' }
  let owner: ReturnType<typeof ownerFromToolUseContext>
  let generation: string | null
  let ledger: ReturnType<typeof seenLinesOf>
  let checking = 'ownership'
  try {
    owner = ownerFromToolUseContext(context)
    checking = 'file generation'
    generation = fileGeneration(expandedPath)
    checking = 'read ledger'
    ledger = seenLinesOf(owner, expandedPath, generation ?? undefined)
  } catch (error) {
    throw new Error(`Read-knowledge ${checking} check failed for ${displayPath}: ${error instanceof Error ? error.message : String(error)}. No edit was applied; retry the Read and edit after that check is available.`, { cause: error })
  }
  const read = readLinesOf(entry, currentContent, includeRead !== false, generation, ledger)
  if (touched !== null && generation !== null && linesOutside(touched, read.ledger).length === 0) return { verdict: 'known' }
  const addressed = named?.lines ?? touched
  if (addressed !== null && addressed.length > 0 && linesOutside(addressed, read.ranges).length === 0) {
    read.separate = true
    read.ranges = read.ledger
  }
  const anchorFailed = anchor !== null && !anchor.ok
  const bound = named?.hunks === true && anchor !== null && anchor.ok ? rangeAnchorWindow(expectedAnchor) : null
  const outsideBound = bound !== null && addressed !== null && linesOutside(addressed, [bound]).length > 0
  const admissible = read.ranges.length > 0 && !read.earlier && !anchorFailed && !outsideBound && generation !== null
  let planned: Carry | null = null
  if (carry !== undefined && addressed !== null && addressed.length > 0) {
    const gaps = linesOutside(addressed, read.ranges)
    try {
      if (gaps.length > 0) planned = planUnreadLines(expandedPath, currentContent, gaps, carry.generation)
    } catch (error) {
      throw new Error(`Read-knowledge carry failed for ${displayPath}: ${error instanceof Error ? error.message : String(error)}. No edit was applied; Read the addressed lines before retrying.`, { cause: error })
    }
    if (planned !== null && planned.rest.length === 0 && admissible) return { verdict: 'carry', gaps, carry: planned }
  }
  const unread = read.ranges.length === 0 && read.separate !== true
  const failed = [
    ...(anchor !== null && !anchor.ok ? [unread ? `Anchor check failed: expected_anchor is not from a Read of ${displayPath} as it stands.` : `Anchor check failed: ${formatAnchorFailure(anchor, expectedAnchor!)}`] : []),
    ...(generation === null ? ['File generation check failed: the current generation could not be read.'] : read.earlier ? ['File generation check failed: earlier read coverage belongs to the file before it changed.'] : []),
    'Read ownership/coverage check failed: neither a recorded Read nor the current owner\'s ledger covers all addressed lines.',
  ].join(' ')
  const neverRead = unread && !read.earlier
  const words = readKnowledgeWords(displayPath, read, unread ? null : addressed, named?.missing ?? 'the old_string was not found in the current content')
  const why = neverRead ? `${UNREAD_EXISTING_FILE_NOTE}; ` : read.earlier ? "it changed after the lines you read, which may be another session's work; " : ''
  const others = why === '' ? '' : otherLiveSessionsClause()
  const lead = unread || (!anchorFailed && !outsideBound)
    ? `Read the file before editing it — ${why}the edit needs ${READ_NEED}.${others}`
    : anchorFailed
      ? `expected_anchor does not match the file as it stands — Read the lines the edit touches again and carry the anchor that Read returns. The edit needs ${READ_NEED}.`
      : `expected_anchor covers lines ${spellLineRanges([bound!])} only, not every line the edit touches — Read the lines outside it, then edit again. The edit needs ${READ_NEED}.`
  return { verdict: 'refused', message: `${lead} ${failed} ${words}`, unread }
}

function rangeAnchorWindow(anchor: string | undefined): LineRange | null {
  const parsed = anchor === undefined ? null : /^ra:[0-9a-f]+:L(\d+)\+(\d+)$/.exec(anchor)
  if (parsed === null) return null
  const start = Number(parsed[1])
  const count = Number(parsed[2])
  return count > 0 ? { start, end: start + count - 1 } : null
}

export function readKnowledgeRefusal(
  context: ToolUseContext,
  expandedPath: string,
  displayPath: string,
  currentContent: string,
  expectedAnchor: string | undefined,
  touched: { start: number; end: number }[] | null,
  includeRead: boolean | 'content' = true,
): string | null {
  const knowledge = readKnowledge(context, expandedPath, displayPath, currentContent, expectedAnchor, touched, includeRead)
  return knowledge.verdict === 'refused' ? knowledge.message : null
}
