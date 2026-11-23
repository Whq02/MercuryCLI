import { addAnchoredLineNumbers } from '../../engines/change-transaction/lineAnchors.js'
import { addLineNumbers } from '../../../platform/files/file.js'
import { RESULT_ROOM_WORDS } from '../../../engine/run/resultRoom.js'
import type { OverCapNote, TextFile } from './schema.js'

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
