import { addAnchoredLineNumbers } from '../../../services/changeTransaction/lineAnchors.js'
import { countTokensWithAPI, roughTokenCountEstimationForFileType } from '../../../services/tokenEstimation.js'
import { addLineNumbers } from '../../../utils/file.js'
import type { ReadFileRangeResult } from '../../../utils/readFileInRange.js'
import { planReadThrough } from '../../FileEditTool/readThrough.js'
import type { FileReadingLimits } from '../limits.js'
import { RESULT_ROOM_WORDS, RESULT_ROOM_WRAPPER_TOKENS } from '../../../services/run/resultRoom.js'
import { MAX_LINES_TO_READ } from '../prompt.js'
import type { OverCapNote, TextFile } from './schema.js'

export class MaxFileReadTokenExceededError extends Error {
  readonly tokenCount: number
  readonly maxTokens: number
  readonly next: OverCapNote['next'] | undefined

  constructor(tokenCount: number, maxTokens: number, words: string, next?: OverCapNote['next']) {
    super(`File content (${tokenCount} tokens) exceeds maximum allowed tokens (${maxTokens}): ${words}`)
    this.name = 'MaxFileReadTokenExceededError'
    this.tokenCount = tokenCount
    this.maxTokens = maxTokens
    this.next = next
  }
}

export function overCapNextWords(next: OverCapNote['next']): string {
  return `Read(offset: ${next.offset}, limit: ${next.limit}) continues from there, or search for specific content instead of reading the whole file.`
}

export const MAX_DISPLAY_LINE_CHARS = 2000

export function numberedReadContent(content: string, startLine: number, anchored: boolean, lossless = false): string {
  const numbered = anchored
    ? addAnchoredLineNumbers({ content, startLine })
    : addLineNumbers({ content, startLine })
  if (lossless) return numbered
  return numbered.split('\n').map(line => {
    const match = /^(\d+(?:#[0-9a-f]+)?\t)([\s\S]*)$/.exec(line)
    if (!match || match[2]!.length <= MAX_DISPLAY_LINE_CHARS) return line
    const raw = match[2]!
    return `${match[1]}${raw.slice(0, MAX_DISPLAY_LINE_CHARS)}… [truncated ${raw.length - MAX_DISPLAY_LINE_CHARS} characters]`
  }).join('\n')
}

export function firstWindowUnderCap(
  whole: ReadFileRangeResult,
  shownCount: number,
  totalLines: number,
  rendered: string,
  lineOffset: number,
  resolvedPath: string,
  ext: string,
  limits: FileReadingLimits,
  tokenCount: number,
): { shown: ReadFileRangeResult; note: OverCapNote } | null {
  const estimate = roughTokenCountEstimationForFileType(rendered, ext)
  const density = estimate > 0 ? Math.max(1, tokenCount / estimate) : 1
  const first = lineOffset + 1
  const plan = planReadThrough(
    rendered,
    [{ start: first, end: first + shownCount - 1 }],
    resolvedPath,
    { maxLines: MAX_LINES_TO_READ, maxTokens: Math.max(1, Math.floor(limits.maxTokens / density) - (limits.room === true ? RESULT_ROOM_WRAPPER_TOKENS : 0)) },
    first,
  )
  const window = plan.windows[0]
  if (window === undefined || window.start !== first) return null
  const count = window.end - window.start + 1
  if (count >= shownCount) return null
  const remaining = Math.max(1, totalLines - window.end)
  const content = whole.content.split('\n').slice(0, count).join('\n')
  return {
    shown: { ...whole, content, lineCount: count, readBytes: Buffer.byteLength(content) },
    note: { tokens: tokenCount, maxTokens: limits.maxTokens, next: { offset: window.end + 1, limit: Math.min(count, remaining) }, ...(limits.room === true ? { room: true as const } : {}) },
  }
}

export async function tokensOverCap(content: string, ext: string, maxTokens: number, exact = true): Promise<number | undefined> {
  const estimate = roughTokenCountEstimationForFileType(content, ext)
  if (!estimate || estimate <= maxTokens / 4) return undefined
  let effective = estimate
  try {
    const accurate = exact ? await countTokensWithAPI(content) : null
    if (accurate !== null) effective = accurate
  } catch {
  }
  return effective > maxTokens ? effective : undefined
}

export function numberedWindow(file: TextFile, anchored: boolean): string {
  const numbered = numberedReadContent(file.content, file.startLine, anchored, file.lossless)
  const phantomPiece = file.content.endsWith('\n') && file.content.split('\n').length === file.numLines + 1
  return phantomPiece ? numbered.slice(0, numbered.lastIndexOf('\n')) : numbered
}

export function windowSpan(file: TextFile): string {
  const last = file.startLine + file.numLines - 1
  return file.numLines === 1 ? `line ${file.startLine}` : `lines ${file.startLine}-${last}`
}

export function cutMark(file: TextFile): string {
  const last = file.startLine + file.numLines - 1
  if (file.startLine <= 1 && last >= file.totalLines) return ''
  if (last >= file.totalLines) return `\n[${windowSpan(file)} of ${file.totalLines} — the end of the file]`
  const limit = Math.min(file.numLines, file.totalLines - last)
  return `\n[${windowSpan(file)} of ${file.totalLines} — Read(offset: ${last + 1}, limit: ${limit}) continues from there]`
}

export function overCapWords(file: TextFile): string {
  const note = file.overCap!
  const shown = `${windowSpan(file)} of ${file.totalLines} ${file.numLines === 1 ? 'is below and counts as read' : 'are below and count as read'}`
  const cap = note.room === true
    ? `exceeds the room left in the context (${note.maxTokens} tokens — ${RESULT_ROOM_WORDS}; read in pieces)`
    : `exceeds maximum allowed tokens (${note.maxTokens})`
  return `File content (${note.tokens} tokens) ${cap}: ${shown}; ${overCapNextWords(note.next)}`
}
