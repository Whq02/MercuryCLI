import type { ToolUseContext } from '../../../Tool.js'
import { relocateStaleHunksFromRing } from '../../../services/changeTransaction/stalePatchRecovery.js'
import { editHunksEnabled, type EditHunkInput } from '../../../services/changeTransaction/hunks.js'
import { runtimeKernel } from '../../../services/primitives/runtimeKernel.js'
import { ownerFromToolUseContext } from '../../../utils/run/resolveOwner.js'
import { activateConditionalSkillsForPaths, addSkillDirectories, discoverSkillDirsForPaths } from '../../../skills/loadSkillsDir.js'
import { getCwd } from '../../../utils/cwd.js'
import { findSimilarFile, getCheckedFileModificationTime, suggestPathUnderCwd } from '../../../utils/file.js'
import { formatFileSize } from '../../../utils/format.js'
import { logError } from '../../../utils/log.js'
import { readFileInRange } from '../../../utils/readFileInRange.js'
import type { FileState } from '../../../utils/fileStateCache.js'
import { MAX_LINES_TO_READ } from '../../../constants/tools/fileRead.js'
import type { FileEditInput, FileEditOutput } from '../types.js'
import { passedOver, passedOverAs } from '../../../utils/passedOver.js'

export const ONE_GIB = 1024 * 1024 * 1024

export const HUNK_SPAN_ELISION = '\n...\n'

export type Output = FileEditOutput

export type FarHeld = { path: string; fileExists: boolean; content: string; lossless: boolean; mtimeMs: number | undefined; missing: () => Promise<string> }

export const tooLargeToEdit = (size: number): string => `File is too large to edit (${formatFileSize(size)}; the maximum is ${formatFileSize(ONE_GIB)}).`

export function decodeFileBuffer(buffer: Buffer): { content: string; encoding: BufferEncoding; lossless: boolean } {
  const encoding: BufferEncoding =
    buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf16le' : 'utf8'
  const raw = buffer.toString(encoding)
  return {
    content: raw.replaceAll('\r\n', '\n'),
    encoding,
    lossless: Buffer.from(raw, encoding).equals(buffer),
  }
}

export async function notFoundSuggestionSentence(expandedPath: string): Promise<string> {
  let suggestion: string | undefined
  try {
    suggestion = await suggestPathUnderCwd(expandedPath)
  } catch {
    suggestion = undefined
  }
  if (suggestion === undefined) suggestion = findSimilarFile(expandedPath)
  return suggestion ? ` Did you mean ${suggestion}?` : ''
}

export function isFullReadEntry(entry: FileState): boolean {
  return (entry.offset === undefined || entry.offset === 0) && entry.limit === undefined
}

export async function staleAtValidation(
  entry: FileState,
  expandedPath: string,
  currentContent: string,
  signal: AbortSignal,
  farMoved?: boolean,
): Promise<boolean> {
  if (farMoved === undefined ? getCheckedFileModificationTime(expandedPath) <= entry.timestamp : !farMoved) return false
  if (isFullReadEntry(entry)) {
    return entry.content !== currentContent
  }
  try {
    const lineOffset = Math.max(0, (entry.offset ?? 1) - 1)
    if (farMoved !== undefined) {
      const lines = currentContent.replace(/^\uFEFF/, '').split('\n')
      return lines.slice(lineOffset, lineOffset + (entry.limit ?? MAX_LINES_TO_READ)).join('\n') !== entry.content
    }
    const window = await readFileInRange(
      expandedPath,
      lineOffset,
      entry.limit ?? MAX_LINES_TO_READ,
      undefined,
      signal,
    )
    return window.content !== entry.content
  } catch (error) {
    passedOver(error)
    return true
  }
}

export function sha16(content: string): string {
  return runtimeKernel().hash.sha256Hex(content).slice(0, 16)
}

export async function discoverSkillsForPath(context: ToolUseContext, filePath: string): Promise<void> {
  try {
    const dirs = await discoverSkillDirsForPaths([filePath], getCwd())
    const fresh = dirs.filter(dir => !context.dynamicSkillDirTriggers?.has(dir))
    for (const dir of fresh) context.dynamicSkillDirTriggers?.add(dir)
    if (fresh.length > 0) {
      void Promise.resolve(addSkillDirectories(fresh)).catch(passedOverAs(undefined))
    }
    activateConditionalSkillsForPaths([filePath], getCwd())
  } catch (err) {
    logError(err)
  }
}

export function patchLineCounts(patch: Array<{ lines: string[] }>): { added: number; removed: number } {
  const marks = patch.flatMap(hunk => hunk.lines.map(line => line[0]))
  return {
    added: marks.filter(mark => mark === '+').length,
    removed: marks.filter(mark => mark === '-').length,
  }
}

export function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0
}

export function hunksInUse(input: FileEditInput): boolean {
  return editHunksEnabled() && Array.isArray(input.hunks) && input.hunks.length > 0
}

export type EditMode = 'exact' | 'hunks' | 'append' | 'section'

export function editMode(input: FileEditInput): EditMode {
  if (hunksInUse(input)) return 'hunks'
  if (hasText(input.section)) return 'section'
  if (hasText(input.append)) return 'append'
  return 'exact'
}

export function attemptStaleHunkRecovery(
  context: ToolUseContext,
  staleAnchor: string,
  currentBody: string,
  hunks: EditHunkInput[],
  displayPath: string,
): { hunks: EditHunkInput[]; freshAnchor: string; note: string } | null {
  try {
    return relocateStaleHunksFromRing(ownerFromToolUseContext(context), staleAnchor, currentBody, hunks, displayPath)
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function splitLeadingBom(content: string): { bom: string; body: string } {
  return content.charCodeAt(0) === 0xfeff
    ? { bom: content.charAt(0), body: content.slice(1) }
    : { bom: '', body: content }
}
