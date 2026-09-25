import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'
import { recallAnchoredSnapshot, rememberAnchoredSnapshot } from '../../services/changeTransaction/snapshotRing.js'
import { recoverStaleHunks, staleEditRecoveryEnabled } from '../../services/changeTransaction/stalePatchRecovery.js'
import {
  applyHunks,
  editHunksEnabled,
  formatHunkOutcomes,
  planApplyRegions,
  planHunks,
  spanText,
  type EditHunkInput,
} from '../../services/changeTransaction/hunks.js'
import { fileGeneration, generationOfWrittenBytes, recordSeenLines, seenLinesOf } from '../../services/changeTransaction/seenLines.js'
import {
  recordNoChangeOutcome,
} from '../../services/changeTransaction/repetitionPolicy.js'
import {
  anchorDomainLines,
  formatFreshAnchorBlocks,
  lineAnchorsEnabled,
  parseHashedLinesSpelling,
} from '../../services/changeTransaction/lineAnchors.js'
import {
  checkAnchor,
  formatAnchorFailure,
  mintFileAnchor,
} from '../../services/changeTransaction/snapshotAnchor.js'
import { serializeIntentDigest } from '../../services/changeTransaction/repetitionPolicy.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { runtimeKernel } from '../../services/primitives/runtimeKernel.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import { getCwd } from '../../utils/cwd.js'
import { countLinesChanged } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTime,
  needsPowerShellBom,
  preserveUntouchedLineEndings,
  suggestPathUnderCwd,
  writeTextContent,
} from '../../utils/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { readFileSyncWithMetadata, type LineEndingType } from '../../utils/fileRead.js'
import { formatFileSize } from '../../utils/format.js'
import { logError } from '../../utils/log.js'
import { NUL_PATH_MESSAGE, expandPath, hasNulByte } from '../../utils/path.js'
import { plural } from '../../utils/stringUtils.js'
import { checkWritePermissionForTool, matchingRuleForInput } from '../../utils/permissions/filesystem.js'
import { readFileInRange } from '../../utils/readFileInRange.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import type { UUID } from 'node:crypto'

import type { FileState } from '../../utils/fileStateCache.js'
import { MAX_LINES_TO_READ } from '../FileReadTool/prompt.js'
import { FILE_EDIT_TOOL_NAME, FILE_UNEXPECTEDLY_MODIFIED_ERROR } from './constants.js'
import { getEditToolDescription } from './prompt.js'
import {
  inputSchema,
  outputSchema,
  type FileEditInput,
  type FileEditOutput,
} from './types.js'
import {
  applyEditToFile,
  areFileEditsInputsEquivalent,
  findActualString,
  getPatchForEdit,
  locateActualString,
  preserveQuoteStyleForFile,
} from './utils.js'
import { findSection, planAppend, planSectionEdit } from './sectionEdit.js'
import {
  READ_THROUGH_MARGIN,
  coalesceLineRanges,
  linesOutside,
  planReadThrough,
  renderCarriedWindows,
  spellLineRanges,
  widenLineRanges,
  type CarriedWindow,
  type LineRange,
  type ReadThroughPlan,
} from './readThrough.js'
import { getPatchFromContents, type StructuredPatchHunk } from '../../utils/diff.js'
import { convertLeadingTabsToSpaces } from '../../utils/file.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'


const ONE_GIB = 1024 * 1024 * 1024
const HUNK_SPAN_ELISION = '\n...\n'

type Output = FileEditOutput

export type { Output }

export const APPLIED_NO_REREAD_NOTE =
  'The change is applied and its lines count as read (a failed call would have errored); no Read is needed before the next edit.'


function decodeFileBuffer(buffer: Buffer): { content: string; encoding: BufferEncoding; lossless: boolean } {
  const encoding: BufferEncoding =
    buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf16le' : 'utf8'
  const raw = buffer.toString(encoding)
  return {
    content: raw.replaceAll('\r\n', '\n'),
    encoding,
    lossless: Buffer.from(raw, encoding).equals(buffer),
  }
}

const LOSSY_DECODE_MESSAGE =
  'File is not valid UTF-8 (or UTF-16LE): editing would rewrite the undecodable bytes as replacement characters (U+FFFD), destroying content the edit never touches. Convert it first (for example `iconv -f cp1252 -t utf-8`), or change it with a shell command that preserves its encoding.'

async function notFoundSuggestionSentence(expandedPath: string): Promise<string> {
  let suggestion: string | undefined
  try {
    suggestion = await suggestPathUnderCwd(expandedPath)
  } catch {
    suggestion = undefined
  }
  if (suggestion === undefined) suggestion = findSimilarFile(expandedPath)
  return suggestion ? ` Did you mean ${suggestion}?` : ''
}

function isFullReadEntry(entry: FileState): boolean {
  return (entry.offset === undefined || entry.offset === 0) && entry.limit === undefined
}

async function staleAtValidation(
  entry: FileState,
  expandedPath: string,
  currentContent: string,
  signal: AbortSignal,
): Promise<boolean> {
  const mtime = getFileModificationTime(expandedPath)
  if (mtime <= entry.timestamp) return false
  if (isFullReadEntry(entry)) {
    return entry.content !== currentContent
  }
  try {
    const lineOffset = Math.max(0, (entry.offset ?? 1) - 1)
    const window = await readFileInRange(
      expandedPath,
      lineOffset,
      entry.limit ?? MAX_LINES_TO_READ,
      undefined,
      signal,
    )
    return window.content !== entry.content
  } catch {
    return true
  }
}

function sha16(content: string): string {
  return runtimeKernel().hash.sha256Hex(content).slice(0, 16)
}

async function discoverSkillsForPath(context: ToolUseContext, filePath: string): Promise<void> {
  try {
    const dirs = await discoverSkillDirsForPaths([filePath], getCwd())
    const fresh = dirs.filter(dir => !context.dynamicSkillDirTriggers?.has(dir))
    for (const dir of fresh) context.dynamicSkillDirTriggers?.add(dir)
    if (fresh.length > 0) {
      void Promise.resolve(addSkillDirectories(fresh)).catch(() => undefined)
    }
    activateConditionalSkillsForPaths([filePath], getCwd())
  } catch (err) {
    logError(err)
  }
}

function patchLineCounts(patch: Array<{ lines: string[] }>): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of patch) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0
}

function hunksInUse(input: FileEditInput): boolean {
  return editHunksEnabled() && Array.isArray(input.hunks) && input.hunks.length > 0
}

type EditMode = 'exact' | 'hunks' | 'append' | 'section'
function editMode(input: FileEditInput): EditMode {
  if (hunksInUse(input)) return 'hunks'
  if (hasText(input.section)) return 'section'
  if (hasText(input.append)) return 'append'
  return 'exact'
}

function linesOfMatches(content: string, oldString: string, replaceAll: boolean): { start: number; end: number }[] | null {
  const actual = findActualString(content, oldString)
  if (actual === null || actual.length === 0) return null
  const ranges: { start: number; end: number }[] = []
  const height = actual.split('\n').length - 1
  let from = 0
  let line = 1
  for (let at = content.indexOf(actual); at !== -1; at = content.indexOf(actual, from)) {
    line += content.slice(from, at).split('\n').length - 1
    ranges.push({ start: line, end: line + height })
    if (!replaceAll) break
    line += height
    from = at + actual.length
  }
  return ranges
}

function readCoversRanges(entry: FileState, ranges: { start: number; end: number }[] | null): boolean {
  if (entry.isPartialView) return false
  if (isFullReadEntry(entry)) return true
  const start = Math.max(1, entry.offset ?? 1)
  const count = Math.min(entry.limit ?? MAX_LINES_TO_READ, entry.content.split('\n').length)
  return ranges !== null && ranges.every(range => range.start >= start && range.end < start + count)
}

const READ_RANGES_NAMED = 5

type CarriedLines = { ranges: LineRange[]; rest: LineRange[]; text: string }

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

function recordCarry(
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

function postLineAtOrAfter(line: number, hunks: readonly StructuredPatchHunk[]): number {
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

function knowledgeBeforeWrite(
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

function writtenBytesOf(expandedPath: string, content: string, encoding: BufferEncoding): Buffer {
  const marked = needsPowerShellBom(expandedPath) && encoding === 'utf8' && !content.startsWith('\uFEFF') ? `\uFEFF${content}` : content
  return Buffer.from(marked, encoding)
}

function stampOwnEditAsSeen(
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
  for (const range of coalesceLineRanges([...shifted, ...authoredLinesOf(patch)])) {
    recordSeenLines(owner, expandedPath, generation, range.start, range.end - range.start + 1)
  }
}

function sameCallReadThrough(gaps: readonly LineRange[], before: string, after: string, patch: readonly StructuredPatchHunk[], expandedPath: string): string {
  const oneGap = gaps.length === 1 && gaps[0]!.start === gaps[0]!.end
  const unread = `${oneGap ? 'Line' : 'Lines'} ${spellLineRanges(gaps)} did not count as read before this edit`
  const mapped = after === before ? [...gaps] : mapRangesThroughPatch(gaps, patch, Math.max(1, lineCountOf(after)))
  const plan = planCarry(after, expandedPath, mapped)
  if (plan.windows.length === 0) return `${unread}.`
  const shown = plan.windows.map(window => ({ start: window.start, end: window.end }))
  const one = shown.length === 1 && shown[0]!.start === shown[0]!.end
  return `${unread}; ${one ? 'line' : 'lines'} ${spellLineRanges(shown)} as ${one ? 'it stands' : 'they stand'} now ${one ? 'is' : 'are'} below, numbered with ${one ? 'its' : 'their'} anchor, and ${one ? 'counts' : 'count'} as read:\n\n${renderCarriedWindows(plan.windows)}`
}

function linesOfHunks(hunks: readonly EditHunkInput[] | undefined): LineRange[] | null {
  if (hunks === undefined || hunks.length === 0) return null
  const ranges: LineRange[] = []
  for (const hunk of hunks) {
    const parsed = /^\s*(\d+)(?:#[0-9a-fA-F]+)?(?:-(\d+)(?:#[0-9a-fA-F]+)?)?\s*$/.exec(hunk.lines)
    if (!parsed) return null
    const start = Number(parsed[1])
    const end = parsed[2] === undefined ? start : Number(parsed[2])
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return null
    ranges.push({ start, end })
  }
  return coalesceLineRanges(ranges)
}

function lineCountOf(text: string): number {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
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

function readKnowledgeWords(displayPath: string, read: ReadLines, addressed: LineRange[] | null, missing: string, carried: CarriedLines | null = null, retry = 'edit again without a Read.'): string {
  const named = read.ranges.slice(0, READ_RANGES_NAMED)
  const rest = read.ranges.length - named.length
  let reads: string
  if (read.separate) {
    reads = `Current owner ledger for ${displayPath}: ${spellLineRanges(read.ledger)}; a separate Read showed ${spellLineRanges(read.recorded)}, but neither source covers the whole edit`
  } else if (read.ranges.length > 0) {
    reads = `Lines of ${displayPath} read this session: ${spellLineRanges(named)}${rest > 0 ? ` (and ${rest} more ${plural(rest, 'range')})` : ''}`
    if (read.earlier) reads += ', plus a read of the file before it last changed'
  } else if (read.earlier) {
    reads = `The lines of ${displayPath} read this session were of the file before it last changed`
  } else if (read.attachmentOnly) {
    reads = `No lines of ${displayPath} were read this session (an automatic attachment showed part of it, which is not a read)`
  } else {
    reads = `No lines of ${displayPath} were read this session`
  }
  if (addressed === null || addressed.length === 0) {
    return `${reads}; ${missing}, so the lines the edit touches are unknown — a Read of the file shows what stands.`
  }
  const one = addressed.length === 1 && addressed[0]!.start === addressed[0]!.end
  const touches = `the edit touches ${one ? 'line' : 'lines'} ${spellLineRanges(addressed)}`
  const gaps = linesOutside(addressed, read.ranges)
  if (carried !== null && carried.ranges.length > 0) {
    const oneBelow = carried.ranges.length === 1 && carried.ranges[0]!.start === carried.ranges[0]!.end
    const below = `${oneBelow ? 'line' : 'lines'} ${spellLineRanges(carried.ranges)} ${oneBelow ? 'is' : 'are'} below and ${oneBelow ? 'counts' : 'count'} as read`
    if (carried.rest.length === 0) return `${reads}; ${touches} — ${below}: ${retry}`
    const next = carried.rest[0]!
    return `${reads}; ${touches} — ${below}; Read(offset: ${next.start}, limit: ${next.end - next.start + 1}) covers the rest${carried.rest.length > 1 ? ` (unread: ${spellLineRanges(carried.rest)})` : ''}, then edit again.`
  }
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

type ReadKnowledge =
  | { verdict: 'known' }
  | { verdict: 'refused'; message: string }
  | { verdict: 'carry'; gaps: LineRange[]; carry: Carry }

const READ_NEED = 'a prior read of the current content (a Read of the lines it touches, or expected_anchor from a full Read of the file as it stands)'

function readKnowledge(
  context: ToolUseContext,
  expandedPath: string,
  displayPath: string,
  currentContent: string,
  expectedAnchor: string | undefined,
  touched: { start: number; end: number }[] | null,
  includeRead: boolean | 'content' = true,
  named?: { lines: LineRange[] | null; missing: string; hunks?: boolean },
  carry?: { generation: string | null; record: boolean },
): ReadKnowledge {
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
    ledger = seenLinesOf(owner, expandedPath)
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
    if (planned !== null && carry.record) recordCarry(owner, expandedPath, planned.generation, planned.windows)
  }
  const carried: CarriedLines | null = planned === null ? null : { ranges: planned.ranges, rest: planned.rest, text: renderCarriedWindows(planned.windows) }
  const full = carried !== null && carried.rest.length === 0
  const retry = anchorFailed || outsideBound ? 'edit again with a carried anchor, without a Read.' : 'edit again without a Read.'
  const failed = [
    ...(anchor !== null && !anchor.ok ? [`Anchor check failed: ${formatAnchorFailure(anchor, expectedAnchor!)}`] : []),
    ...(generation === null ? ['File generation check failed: the current generation could not be read.'] : read.earlier ? ['File generation check failed: earlier read coverage belongs to the file before it changed.'] : []),
    'Read ownership/coverage check failed: neither a recorded Read nor the current owner\'s ledger covers all addressed lines.',
  ].join(' ')
  const words = readKnowledgeWords(displayPath, read, addressed, named?.missing ?? 'the old_string was not found in the current content', carried, retry)
  const lead = !full
    ? `Read the file before editing it — the edit needs ${READ_NEED}.`
    : anchorFailed
      ? `expected_anchor does not match the file as it stands; the lines the edit touches are below with their current anchor and count as read: ${retry} The edit needs ${READ_NEED}.`
      : outsideBound
        ? `expected_anchor covers lines ${spellLineRanges([bound!])} only, not every line the edit touches; the lines the edit touches are below with their current anchor and count as read: ${retry} The edit needs ${READ_NEED}.`
      : read.earlier
        ? `The file ${displayPath} changed after the lines you read; the lines the edit touches, as they stand now, are below and count as read: check them, then ${retry} The edit needs ${READ_NEED}.`
        : `The lines the edit touches are below and count as read: ${retry} The edit needs ${READ_NEED}.`
  const law = `${lead} ${failed} ${words}`
  return { verdict: 'refused', message: carried === null ? law : `${law}\n\n${carried.text}` }
}

function rangeAnchorWindow(anchor: string | undefined): LineRange | null {
  const parsed = anchor === undefined ? null : /^ra:[0-9a-f]+:L(\d+)\+(\d+)$/.exec(anchor)
  if (parsed === null) return null
  const start = Number(parsed[1])
  const count = Number(parsed[2])
  return count > 0 ? { start, end: start + count - 1 } : null
}

function readKnowledgeRefusal(
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

function attemptStaleHunkRecovery(
  context: ToolUseContext,
  staleAnchor: string,
  currentBody: string,
  hunks: EditHunkInput[],
  displayPath: string,
): { hunks: EditHunkInput[]; freshAnchor: string; note: string } | null {
  if (!staleEditRecoveryEnabled()) return null
  try {
    const owner = ownerFromToolUseContext(context)
    const recalled = recallAnchoredSnapshot(owner, staleAnchor)
    if (!recalled) return null
    const outcome = recoverStaleHunks({
      staleAnchor,
      snapshotContent: recalled.content,
      currentContent: currentBody,
      hunks,
      displayPath,
    })
    if (!outcome.ok) return null
    return {
      hunks: outcome.hunks,
      freshAnchor: mintFileAnchor(currentBody),
      note: outcome.warnings.join('; '),
    }
  } catch {
    return null
  }
}

function splitLeadingBom(content: string): { bom: string; body: string } {
  return content.charCodeAt(0) === 0xfeff
    ? { bom: content.charAt(0), body: content.slice(1) }
    : { bom: '', body: content }
}


export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  strict: true,
  keepEmptyInputs: ['old_string', 'new_string'],
  straightQuoteInputs: ['file_path'],
  maxResultSizeChars: 100_000,
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  async description(): Promise<string> {
    return 'A tool for editing files'
  },
  async prompt({ tools }): Promise<string> {
    return getEditToolDescription(new Set(tools.map(tool => tool.name)))
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input: Partial<FileEditInput> | undefined): string {
    return input?.file_path ? `Editing ${input.file_path}` : 'Editing a file'
  },
  toAutoClassifierInput(input: FileEditInput): string {
    return input.file_path
  },
  getPath(input: Partial<FileEditInput> | undefined): string {
    return input?.file_path || getCwd()
  },
  async checkPermissions(input: FileEditInput, context: ToolUseContext) {
    return checkWritePermissionForTool(
      { name: FILE_EDIT_TOOL_NAME, getPath: (i: Partial<FileEditInput> | undefined) => i?.file_path || getCwd() },
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  backfillObservableInput(input: FileEditInput): void {
    if (hasNulByte(input.file_path)) return
    input.file_path = expandPath(input.file_path)
  },
  inputsEquivalent(a: FileEditInput, b: FileEditInput): boolean {
    const mode = editMode(a)
    if (mode !== editMode(b)) return false
    if ((hasText(a.expected_anchor) ? a.expected_anchor : undefined) !== (hasText(b.expected_anchor) ? b.expected_anchor : undefined)) return false
    if (mode === 'hunks') {
      return a.file_path === b.file_path && JSON.stringify(a.hunks) === JSON.stringify(b.hunks)
    }
    if (mode === 'append' || mode === 'section') {
      return a.file_path === b.file_path &&
        (hasText(a.section) ? a.section : undefined) === (hasText(b.section) ? b.section : undefined) &&
        (hasText(a.append) ? a.append : undefined) === (hasText(b.append) ? b.append : undefined) &&
        (hasText(a.append) ? undefined : a.new_string) === (hasText(b.append) ? undefined : b.new_string)
    }
    return areFileEditsInputsEquivalent(
      {
        file_path: a.file_path,
        edits: [
          {
            old_string: a.old_string ?? '',
            new_string: a.new_string ?? '',
            replace_all: a.replace_all ?? false,
          },
        ],
      },
      {
        file_path: b.file_path,
        edits: [
          {
            old_string: b.old_string ?? '',
            new_string: b.new_string ?? '',
            replace_all: b.replace_all ?? false,
          },
        ],
      },
    )
  },
  async validateInput(input: FileEditInput, context: ToolUseContext) {
    if (hasNulByte(input.file_path)) {
      return { result: false as const, message: NUL_PATH_MESSAGE, errorCode: 1 }
    }
    const usingHunks = hunksInUse(input)
    const mode = editMode(input)

    if (mode === 'append' || mode === 'section') {
      const clash =
        hasText(input.old_string) ||
        (Array.isArray(input.hunks) && input.hunks.length > 0) ||
        input.replace_all === true ||
        (mode === 'append' && hasText(input.new_string)) ||
        (mode === 'section' && hasText(input.append) && hasText(input.new_string)) ||
        (mode === 'section' && !hasText(input.append) && input.new_string === undefined)
      if (clash) {
        return {
          result: false as const,
          behavior: 'ask' as const,
          message:
            mode === 'append'
              ? 'append stands alone (or with section): drop old_string, new_string and hunks.'
              : 'section takes exactly one of new_string (replace the section) or append (add inside it), and no old_string or hunks.',
          errorCode: 13,
        }
      }
    } else if (!usingHunks && (input.old_string === undefined || input.new_string === undefined)) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: 'old_string and new_string are required unless hunks, append or section are provided.',
        errorCode: 13,
      }
    }
    if (
      usingHunks &&
      (hasText(input.old_string) || hasText(input.new_string) || hasText(input.section) || hasText(input.append) || input.replace_all)
    ) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message:
          'hunks and old_string/new_string/replace_all are mutually exclusive — use one edit mode per call.',
        errorCode: 13,
      }
    }
    if (usingHunks && !hasText(input.expected_anchor)) {
      const everyHunkAnchorQualified =
        lineAnchorsEnabled() &&
        (input.hunks ?? []).every(h => parseHashedLinesSpelling(h.lines) !== null)
      if (!everyHunkAnchorQualified) {
        return {
          result: false as const,
          behavior: 'ask' as const,
          message:
            'hunks require expected_anchor — carry the parenthesised "(anchor: …)" value from your preceding Read of this file.' +
            (lineAnchorsEnabled()
              ? ' (Or anchor-qualify EVERY hunk\'s lines from a line_anchors read — "12#ab3f" — and the line anchors themselves are the staleness contract.)'
              : ''),
          errorCode: 13,
        }
      }
    }

    const expandedPath = expandPath(input.file_path)

    const proposedBodies = usingHunks
      ? (input.hunks ?? []).map(hunk => hunk.replace)
      : [input.new_string ?? input.append ?? '']
    for (const body of proposedBodies) {
    }

    const oldString = input.old_string ?? ''
    const newString = input.new_string ?? ''

    const { old_string, new_string } = input
    if (mode === 'exact' && oldString !== '' && old_string === new_string) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: 'old_string and new_string are identical — there is no edit to apply.',
        errorCode: 1,
      }
    }

    const permissionContext = context.getAppState().toolPermissionContext
    if (matchingRuleForInput(expandedPath, permissionContext, 'edit', 'deny')) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: `Editing ${input.file_path} is denied by permission settings.`,
        errorCode: 2,
      }
    }

    if (input.file_path.startsWith('\\\\') || input.file_path.startsWith('//')) {
      return { result: true as const }
    }

    let generationAtStat: string | null = null
    try {
      const stats = await stat(expandedPath)
      if (stats.size > ONE_GIB) {
        return {
          result: false as const,
          behavior: 'ask' as const,
          message: `File is too large to edit (${formatFileSize(stats.size)}; the maximum is ${formatFileSize(ONE_GIB)}).`,
          errorCode: 10,
        }
      }
      generationAtStat = fileGeneration(expandedPath)
    } catch (err) {
      if (!isENOENT(err)) throw err
    }

    let fileExists = true
    let currentContent = ''
    let decodeLossless = true
    try {
      const buffer = await readFile(expandedPath)
      const decoded = decodeFileBuffer(buffer)
      currentContent = decoded.content
      decodeLossless = decoded.lossless
    } catch (err) {
      if (!isENOENT(err)) throw err
      fileExists = false
    }
    if (fileExists && !decodeLossless) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: LOSSY_DECODE_MESSAGE,
        errorCode: 14,
      }
    }

    if (!fileExists) {
      if (mode === 'exact' && oldString === '') {
        return { result: true as const }
      }
      if (mode === 'append') {
        return { result: true as const }
      }
      const suggestion = await notFoundSuggestionSentence(expandedPath)
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.${suggestion}`,
        errorCode: 4,
        meta: { isPathAbsolute: String(isAbsolute(input.file_path)) },
      }
    }

    if (mode === 'exact' && oldString === '') {
      if (currentContent.trim() !== '') {
        return {
          result: false as const,
          behavior: 'ask' as const,
          message:
            'Cannot create a new file — a file already exists at this path with content in it.',
          errorCode: 3,
        }
      }
      return { result: true as const }
    }

    if (expandedPath.toLowerCase().endsWith('.ipynb')) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: 'Use the NotebookEdit tool to edit Jupyter notebooks.',
        errorCode: 5,
      }
    }

    const touched =
      mode === 'exact'
        ? linesOfMatches(currentContent, oldString, input.replace_all === true)
        : mode === 'section'
          ? (() => {
              const found = findSection(currentContent, input.section ?? '')
              return found.ok ? [{ start: found.start, end: found.end }] : null
            })()
          : mode === 'hunks'
            ? linesOfHunks(input.hunks as EditHunkInput[] | undefined)
            : null
    const knowledge =
      mode === 'append'
        ? null
        : readKnowledge(context, expandedPath, input.file_path, currentContent, input.expected_anchor, touched, true, {
            lines: touched,
            missing:
              mode === 'section'
                ? 'the section heading was not found in the current content'
                : mode === 'hunks'
                  ? "a hunk's line address does not parse"
                  : 'the old_string was not found in the current content',
            hunks: mode === 'hunks',
          }, { generation: generationAtStat, record: true })
    if (knowledge !== null && knowledge.verdict === 'refused') {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: knowledge.message,
        errorCode: 6,
        meta: { isPathAbsolute: String(isAbsolute(input.file_path)) },
      }
    }

    const entry = context.readFileState.get(expandedPath)
    if (
      mode !== 'append' &&
      entry !== undefined &&
      !entry.isPartialView &&
      (await staleAtValidation(entry, expandedPath, currentContent, context.abortController.signal)) &&
      readKnowledgeRefusal(context, expandedPath, input.file_path, currentContent, input.expected_anchor, touched, false) !== null
    ) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: FILE_UNEXPECTEDLY_MODIFIED_ERROR,
        errorCode: 7,
      }
    }

    let recoveredHunks: EditHunkInput[] | undefined
    let recoveredAnchor: string | undefined
    if (changeTransactionEnabled() && hasText(input.expected_anchor)) {
      const check = checkAnchor(input.expected_anchor, currentContent, input.file_path)
      if (!check.ok) {
        const recovery =
          check.reason !== 'malformed' && usingHunks
            ? attemptStaleHunkRecovery(
                context,
                input.expected_anchor,
                splitLeadingBom(currentContent).body,
                input.hunks as EditHunkInput[],
                input.file_path,
              )
            : null
        if (recovery === null) {
          return {
            result: false as const,
            behavior: 'ask' as const,
            message: formatAnchorFailure(check, input.expected_anchor),
            errorCode: check.reason === 'malformed' ? 12 : 11,
            meta: check.currentAnchor ? { currentAnchor: check.currentAnchor } : undefined,
          }
        }
        recoveredHunks = recovery.hunks
        recoveredAnchor = recovery.freshAnchor
      }
    }

    if (usingHunks) {
      const { bom, body } = splitLeadingBom(currentContent)
      const plan = planHunks(body, recoveredHunks ?? (input.hunks as EditHunkInput[]), recoveredAnchor ?? input.expected_anchor)
      if (!plan.ok) {
        return {
          result: false as const,
          behavior: 'ask' as const,
          message: `${plan.message} Nothing was written.${plan.outcomes.length > 1 ? ` Outcomes: ${formatHunkOutcomes(plan.outcomes)}.` : ''}`,
          errorCode: 13,
        }
      }
      const settingsRefusal = validateInputForSettingsFileEdit(
        expandedPath,
        currentContent,
        () => bom + applyHunks(body, plan),
      )
      if (settingsRefusal !== null) {
        return { ...settingsRefusal, behavior: 'ask' as const }
      }
      return { result: true as const, meta: { plannedHunkCount: String(plan.spans.length) } }
    }

    if (mode === 'append' || mode === 'section') {
      const planned =
        mode === 'append'
          ? { ok: true as const, updated: planAppend(currentContent, input.append ?? '') }
          : planSectionEdit(
              currentContent,
              input.section ?? '',
              hasText(input.append) ? { append: input.append } : { replace: input.new_string ?? '' },
            )
      if (!planned.ok) {
        return { result: false as const, behavior: 'ask' as const, message: `${planned.message} Nothing was written.`, errorCode: 8 }
      }
      const settingsRefusal = validateInputForSettingsFileEdit(expandedPath, currentContent, () => planned.updated)
      if (settingsRefusal !== null) {
        return { ...settingsRefusal, behavior: 'ask' as const }
      }
      return { result: true as const }
    }

    const located = locateActualString(currentContent, oldString)
    if (located.kind === 'ambiguous') {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: input.replace_all
          ? `Found ${located.count} matches of the string to replace, but they differ from each other in whitespace or characters, so replace_all cannot rewrite them as one string. Provide more surrounding context to uniquely identify one instance, or spell old_string as the file does.\nString: ${oldString}`
          : `Found ${located.count} matches of the string to replace, but replace_all is false. ` +
            `To replace all occurrences, set replace_all to true. To replace only one occurrence, provide more surrounding context to uniquely identify the instance.\nString: ${oldString}`,
        errorCode: 9,
        meta: { oldString },
      }
    }
    const actualOldString = located.kind === 'found' ? located.actual : null
    if (actualOldString === null) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: `The old_string was not found in the file.\nString: ${oldString}`,
        errorCode: 8,
        meta: { isPathAbsolute: String(isAbsolute(input.file_path)) },
      }
    }
    const occurrences = currentContent.split(actualOldString).length - 1
    if (occurrences > 1 && !input.replace_all) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message:
          `Found ${occurrences} matches of the string to replace, but replace_all is false. ` +
          `To replace all occurrences, set replace_all to true. To replace only one occurrence, provide more surrounding context to uniquely identify the instance.\nString: ${oldString}`,
        errorCode: 9,
        meta: { oldString, actualOldString },
      }
    }

    const preservedNewString = await preserveQuoteStyleForFile(expandedPath, currentContent, oldString, actualOldString, newString)
    const settingsRefusal = validateInputForSettingsFileEdit(expandedPath, currentContent, () =>
      applyEditToFile(currentContent, actualOldString, preservedNewString, input.replace_all),
    )
    if (settingsRefusal !== null) {
      return { ...settingsRefusal, behavior: 'ask' as const }
    }

    return { result: true as const, meta: { actualOldString } }
  },
  async call(input: FileEditInput, context: ToolUseContext, _canUseTool, parentMessage) {
    const startedAt = Date.now()
    const expandedPath = expandPath(input.file_path)
    const usingHunks = hunksInUse(input)
    const mode = editMode(input)
    const anchorChecked = changeTransactionEnabled() && hasText(input.expected_anchor)

    if (!isEnvTruthy(process.env.MERCURY_BARE)) {
      await discoverSkillsForPath(context, expandedPath)
    }
    await diagnosticTracker.beforeFileEdited(expandedPath)
    const parentDir = expandedPath.split(/[\\/]/).slice(0, -1).join('/')
    if (parentDir) {
      await getFsImplementation().mkdir(parentDir)
    }
    if (fileHistoryEnabled()) {
      await fileHistoryTrackEdit(
        context.updateFileHistoryState,
        expandedPath,
        parentMessage.uuid as UUID,
      )
    }

    let freshContent = ''
    let rawBefore = ''
    let fileExists = true
    let encoding: BufferEncoding = 'utf8'
    let lineEndings: LineEndingType = 'LF'
    try {
      const metadata = readFileSyncWithMetadata(expandedPath)
      if (!metadata.losslessDecode) {
        throw new Error(`${LOSSY_DECODE_MESSAGE} Nothing was written.`)
      }
      freshContent = metadata.content
      rawBefore = metadata.rawContent
      encoding = metadata.encoding
      lineEndings = metadata.lineEndings
    } catch (err) {
      if (!isENOENT(err)) throw err
      fileExists = false
    }

    let sameCall: Extract<ReadKnowledge, { verdict: 'carry' }> | null = null
    if (fileExists && mode !== 'append') {
      const touched = mode === 'exact'
        ? linesOfMatches(freshContent, input.old_string ?? '', input.replace_all === true)
        : mode === 'section'
          ? (() => {
              const found = findSection(freshContent, input.section ?? '')
              return found.ok ? [{ start: found.start, end: found.end }] : null
            })()
          : mode === 'hunks'
            ? linesOfHunks(input.hunks as EditHunkInput[] | undefined)
            : null
      const entry = context.readFileState.get(expandedPath)
      const intact = entry !== undefined && readCoversRanges(entry, touched) && (
        getFileModificationTime(expandedPath) <= entry.timestamp ||
        (isFullReadEntry(entry) && entry.content === freshContent)
      )
      if (!intact) {
        const knowledge = readKnowledge(context, expandedPath, input.file_path, freshContent, input.expected_anchor, touched, 'content', undefined, { generation: fileGeneration(expandedPath), record: false })
        if (knowledge.verdict === 'refused') throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
        if (knowledge.verdict === 'carry') {
          recordCarry(ownerFromToolUseContext(context), expandedPath, knowledge.carry.generation, knowledge.carry.windows)
          sameCall = knowledge
        }
      }
    }

    let effectiveHunks = input.hunks as EditHunkInput[] | undefined
    let effectiveAnchor = input.expected_anchor
    let staleRecoveryNote: string | undefined
    if (anchorChecked && hasText(input.expected_anchor)) {
      const check = checkAnchor(input.expected_anchor, freshContent, input.file_path)
      if (!check.ok) {
        const recovery =
          check.reason !== 'malformed' && usingHunks
            ? attemptStaleHunkRecovery(
                context,
                input.expected_anchor,
                splitLeadingBom(freshContent).body,
                input.hunks as EditHunkInput[],
                input.file_path,
              )
            : null
        if (recovery === null) {
          throw new Error(formatAnchorFailure(check, input.expected_anchor))
        }
        effectiveHunks = recovery.hunks
        effectiveAnchor = recovery.freshAnchor
        staleRecoveryNote = recovery.note
      }
    }

    let updatedFile: string
    let patch: ReturnType<typeof getPatchFromContents>
    let reportedOldString: string
    let reportedNewString: string
    let freshLineAnchors: string | undefined
    if (usingHunks) {
      const { bom, body } = splitLeadingBom(freshContent)
      const plan = planHunks(body, effectiveHunks as EditHunkInput[], effectiveAnchor)
      if (!plan.ok) {
        throw new Error(`${plan.message} Nothing was written.${plan.outcomes.length > 1 ? ` Outcomes: ${formatHunkOutcomes(plan.outcomes)}.` : ''}`)
      }
      updatedFile = bom + applyHunks(body, plan)
      if (
        lineAnchorsEnabled() &&
        (effectiveHunks as EditHunkInput[]).some(h => parseHashedLinesSpelling(h.lines) !== null)
      ) {
        const block = formatFreshAnchorBlocks(anchorDomainLines(updatedFile), planApplyRegions(plan))
        if (block !== '') freshLineAnchors = block
      }
      reportedOldString = plan.spans
        .map(span => spanText(body, span))
        .join(HUNK_SPAN_ELISION)
      reportedNewString = (effectiveHunks as EditHunkInput[])
        .map(hunk => hunk.replace)
        .join(HUNK_SPAN_ELISION)
      patch =
        updatedFile === freshContent
          ? []
          : getPatchFromContents({
              filePath: expandedPath,
              oldContent: convertLeadingTabsToSpaces(freshContent),
              newContent: convertLeadingTabsToSpaces(updatedFile),
            })
    } else if (mode === 'append' || mode === 'section') {
      const planned =
        mode === 'append'
          ? { ok: true as const, updated: planAppend(freshContent, input.append ?? ''), sectionText: '' }
          : planSectionEdit(
              freshContent,
              input.section ?? '',
              hasText(input.append) ? { append: input.append } : { replace: input.new_string ?? '' },
            )
      if (!planned.ok) {
        throw new Error(`${planned.message} Nothing was written.`)
      }
      updatedFile = planned.updated
      reportedOldString = planned.sectionText
      reportedNewString = hasText(input.append) ? input.append : input.new_string ?? ''
      patch =
        updatedFile === freshContent
          ? []
          : getPatchFromContents({
              filePath: expandedPath,
              oldContent: convertLeadingTabsToSpaces(freshContent),
              newContent: convertLeadingTabsToSpaces(updatedFile),
            })
    } else {
      const oldString = input.old_string ?? ''
      const newString = input.new_string ?? ''
      const actualOldString = findActualString(freshContent, oldString) ?? oldString
      const preserved = await preserveQuoteStyleForFile(expandedPath, freshContent, oldString, actualOldString, newString)
      const result = getPatchForEdit({
        filePath: expandedPath,
        fileContents: freshContent,
        oldString: actualOldString,
        newString: preserved,
        replaceAll: input.replace_all,
      })
      updatedFile = result.updatedFile
      patch = result.patch
      reportedOldString = oldString
      reportedNewString = newString
    }
    const readThrough = sameCall === null ? undefined : sameCallReadThrough(sameCall.gaps, freshContent, updatedFile, patch, expandedPath)

    const userModified = context.userModifiedInput === true
    const replaceAll = input.replace_all ?? false

    if (updatedFile === freshContent) {
      const owner = ownerFromToolUseContext(context)
      const intentDigest = serializeIntentDigest(
        usingHunks
          ? [
              input.expected_anchor ?? '',
              ...(input.hunks as EditHunkInput[]).flatMap(hunk => [
                hunk.lines,
                hunk.replace,
                hunk.insert ?? '',
              ]),
            ]
          : mode === 'exact'
            ? [reportedOldString, reportedNewString, replaceAll]
            : [mode, input.section ?? '', input.append ?? '', input.new_string ?? ''],
      )
      const verdict = recordNoChangeOutcome(owner, {
        operation: 'file.edit',
        path: expandedPath,
        revision: mintFileAnchor(freshContent),
        intentDigest,
        displayPath: input.file_path,
      })
      const data: Output = {
        filePath: expandedPath,
        oldString: reportedOldString,
        newString: reportedNewString,
        originalFile: freshContent,
        structuredPatch: [],
        userModified,
        replaceAll,
        noChange: { streak: verdict.streak, stop: verdict.atCeiling, guidance: verdict.guidance },
        ...(readThrough !== undefined ? { readThrough } : {}),
      }
      return {
        data,
        effect: {
          outcome: 'no-change' as const,
          operation: 'file.edit',
          changedPaths: [],
          evidence: usingHunks
            ? 'hunks lane: the planned result is byte-identical to the current content'
            : `${mode === 'exact' ? 'exact-string' : mode} mode: the computed result is byte-identical to the current content`,
          startedAt,
          completedAt: Date.now(),
          details: { anchorChecked },
        },
      }
    }

    const reconciled = fileExists
      ? preserveUntouchedLineEndings(rawBefore, updatedFile, lineEndings)
      : updatedFile
    const owner = ownerFromToolUseContext(context)
    const knownBeforeWrite = fileExists
      ? knowledgeBeforeWrite(context, expandedPath, input.file_path, freshContent, input.expected_anchor, fileGeneration(expandedPath), seenLinesOf(owner, expandedPath))
      : []
    writeTextContent(expandedPath, reconciled, encoding, fileExists ? 'LF' : lineEndings)
    const writtenAt = getFileModificationTime(expandedPath)
    stampOwnEditAsSeen(owner, expandedPath, generationOfWrittenBytes(expandedPath, writtenBytesOf(expandedPath, reconciled, encoding)), knownBeforeWrite, patch, updatedFile)

    const lspManager = getLspServerManager()
    if (lspManager) {
      try {
        clearDeliveredDiagnosticsForFile(`file://${expandedPath}`)
        await lspManager.changeAndSaveFile(expandedPath, updatedFile)
      } catch (err) {
        logError(err)
      }
    }
    notifyVscodeFileUpdated(expandedPath, freshContent, updatedFile)

    context.readFileState.set(expandedPath, {
      content: updatedFile,
      timestamp: writtenAt,
      offset: undefined,
      limit: undefined,
    })

    countLinesChanged(patch, fileExists ? undefined : updatedFile)
    logFileOperation({
      operation: 'edit',
      tool: 'FileEditTool',
      filePath: expandedPath,
      content: updatedFile,
    })

    const gitDiff: Output['gitDiff'] = undefined

    const { added, removed } = patchLineCounts(patch)
    const hunkCount = usingHunks ? (input.hunks as EditHunkInput[]).length : 0
    const data: Output = {
      filePath: expandedPath,
      oldString: reportedOldString,
      newString: reportedNewString,
      originalFile: freshContent,
      structuredPatch: patch,
      userModified,
      replaceAll,
      ...(gitDiff !== undefined ? { gitDiff } : {}),
      ...(freshLineAnchors !== undefined ? { freshLineAnchors } : {}),
      ...(staleRecoveryNote !== undefined ? { staleRecovery: staleRecoveryNote } : {}),
      ...(readThrough !== undefined ? { readThrough } : {}),
    }
    return {
      data,
      effect: {
        outcome: 'succeeded' as const,
        operation: 'file.edit',
        changedPaths: [expandedPath],
        evidence: usingHunks
          ? `applied ${hunkCount} anchored hunk(s): +${added}/-${removed} lines${staleRecoveryNote !== undefined ? ` · ${staleRecoveryNote}` : ''}`
          : `${mode === 'exact' ? 'exact-string' : mode} mode: +${added}/-${removed} lines`,
        startedAt,
        completedAt: Date.now(),
        details: {
          digest: sha16(updatedFile),
          bytes: Buffer.byteLength(updatedFile, 'utf8'),
          anchorChecked,
        },
      },
    }
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    if (data.noChange) {
      const text =
        `No changes made to ${data.filePath}: the computed result is byte-identical to the current file content, so nothing was written. ` +
        data.noChange.guidance
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: data.readThrough !== undefined ? `${text}\n\n${data.readThrough}` : text,
        ...(data.noChange.stop ? { is_error: true } : {}),
      }
    }
    const modifiedClause = data.userModified ? ' (the user modified the change before accepting it)' : ''
    const located = data.oldString === '' || data.oldString.includes(HUNK_SPAN_ELISION) ? null : locateActualString(data.originalFile, data.oldString)
    const forgivenClause = located !== null && located.kind === 'found' && located.feedback !== null ? ` ${located.feedback}` : ''
    const closingClause = data.staleRecovery !== undefined ? ` Your hunks were relocated because the file changed since your read (${data.staleRecovery}) — re-read before further anchored edits.` : data.userModified ? '' : ` ${APPLIED_NO_REREAD_NOTE}`
    const text = data.replaceAll
      ? `The file ${data.filePath} has been updated${modifiedClause}. All occurrences of the string were replaced.${forgivenClause}${closingClause}`
      : `The file ${data.filePath} has been updated successfully${modifiedClause}.${forgivenClause}${closingClause}`
    const anchored = data.freshLineAnchors !== undefined ? `${text}\n\n${data.freshLineAnchors}` : text
    const content = data.readThrough !== undefined ? `${anchored}\n\n${data.readThrough}` : anchored
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content }
  },
  extractSearchText(data: Output): string {
    if (data.noChange) return ''
    return data.structuredPatch
      .flatMap(hunk => hunk.lines)
      .map(line => (/^[+\- ]/.test(line) ? line.slice(1) : line))
      .join('\n')
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
})
