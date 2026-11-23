import { jsonQueryDiscovery, jsonQueryName, parseReadQueryTarget } from '../readQueryTarget.js'
import type { TextFile } from './schema.js'
import { resultLineAnchors, resultOutlineBodies, resultResolvedNames, resultPreRenderedBody, resultWithoutProfileHint } from './results.js'
import { MAX_DISPLAY_LINE_CHARS, numberedWindow, cutMark, overCapWords } from './windowText.js'

export function serializeTextResult(file: TextFile, data: object): string {
  const resolvedName = resultResolvedNames.get(data)
  const resolvedNote = resolvedName !== undefined ? `(resolved near-miss filename to ${resolvedName})\n` : ''
  const preRendered = resultPreRenderedBody.get(data)
  const partialJson = jsonQueryName(file.filePath) && parseReadQueryTarget(file.filePath) === null && (file.startLine > 1 || file.startLine + file.numLines - 1 < file.totalLines || file.overCap !== undefined || (!file.lossless && file.content.split('\n').some(line => line.length > MAX_DISPLAY_LINE_CHARS)))
  const queryHint = partialJson ? `\n${jsonQueryDiscovery(file.filePath)}` : ''
  if (preRendered !== undefined) {
    return `${resolvedNote}${preRendered}${file.anchor !== undefined ? `\n(anchor: ${file.anchor})` : ''}${queryHint}`
  }
  if (file.content === '') {
    if (file.totalLines > 0 && file.startLine > file.totalLines) {
      return `${resolvedNote}<system-reminder>Warning: the file exists but is shorter than the requested offset. Read was requested to start at line ${file.startLine}, but the file has only ${file.totalLines} ${file.totalLines === 1 ? 'line' : 'lines'}.</system-reminder>`
    }
    return `${resolvedNote}<system-reminder>Warning: the file exists but has empty contents.</system-reminder>${file.anchor !== undefined ? `\n(anchor: ${file.anchor})` : ''}`
  }
  const prefix =
    file.memoryUpdatedAt !== undefined
      ? `(memory file — last updated ${new Date(file.memoryUpdatedAt).toISOString()})\n`
      : ''
  const capNote = file.overCap === undefined ? '' : `${overCapWords(file)}\n`
  const numbered = resultOutlineBodies.get(data) ?? numberedWindow(file, resultLineAnchors.has(data))
  const anchorSuffix = file.anchor !== undefined ? `\n(anchor: ${file.anchor})` : ''
  const profileHint = !resultWithoutProfileHint.has(data) && /\.(?:cpuprofile|sample\.txt)$/i.test(file.filePath) ? `\nProfile summary: Read(file_path: ${JSON.stringify(`${file.filePath}#read?view=profile`)}).` : ''
  return `${resolvedNote}${prefix}${capNote}${numbered}${conflictMark(file.content)}${cutMark(file)}${anchorSuffix}${queryHint}${profileHint}`
}

export function unresolvedConflictBlocks(content: string): number {
  let count = 0
  let open = false
  for (const line of content.split('\n')) {
    if (/^<{7}(?: |$)/.test(line)) open = true
    else if (open && /^>{7}(?: |$)/.test(line)) {
      count++
      open = false
    }
  }
  return count
}

function conflictMark(content: string): string {
  const count = unresolvedConflictBlocks(content)
  if (count === 0) return ''
  return `\n[${count} unresolved merge-conflict ${count === 1 ? 'block' : 'blocks'} (<<<<<<< ======= >>>>>>>) in the lines returned — resolve them before relying on this content]`
}
