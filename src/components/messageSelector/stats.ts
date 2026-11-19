import { basename } from 'path'
import { isRemotePath } from '../../services/remoteFiles/target.js'
import { isSqliteRowTarget } from '../../tools/FileWriteTool/structuredTargets.js'
import type { Message } from '../../types/message.js'

export type CodeStats = { filesChanged: string[]; insertions: number; deletions: number }

type PatchHunk = { lines?: string[] }
type EditResult = {
  filePath?: string
  file_path?: string
  structuredPatch?: PatchHunk[]
  type?: string
  content?: string
  outcome?: string
  changeView?: { state?: string; files?: Array<{ file: string; added: number; removed: number }> }
}

function createdLineCount(content: string): number {
  if (content === '') return 0
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
}

export function statsBetween(
  messages: Message[],
  fromUuid: string,
  toUuid: string | undefined,
): { files: string[]; insertions: number; deletions: number } {
  const start = messages.findIndex(message => message.uuid === fromUuid)
  const end =
    toUuid === undefined
      ? messages.length
      : messages.findIndex(message => message.uuid === toUuid)
  const files = new Set<string>()
  let insertions = 0
  let deletions = 0
  for (let i = start + 1; i < (end === -1 ? messages.length : end); i++) {
    const message = messages[i]!
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content) || content[0]?.type !== 'tool_result') continue
    const result = (message as { toolUseResult?: unknown }).toolUseResult as
      | EditResult
      | undefined
    if (!result || typeof result !== 'object') continue
    if (result.changeView !== undefined && Array.isArray(result.changeView.files)) {
      if (result.changeView.state === 'applied' && result.outcome === 'succeeded') {
        for (const changed of result.changeView.files) {
          files.add(changed.file)
          insertions += changed.added
          deletions += changed.removed
        }
      }
      continue
    }
    const filePath = result.filePath ?? result.file_path
    if (typeof filePath !== 'string') continue
    if (isSqliteRowTarget(filePath)) continue
    if (result.type === 'create' && typeof result.content === 'string') {
      files.add(filePath)
      insertions += createdLineCount(result.content)
      continue
    }
    if (!Array.isArray(result.structuredPatch)) continue
    files.add(filePath)
    for (const hunk of result.structuredPatch) {
      if (!Array.isArray(hunk.lines)) continue
      for (const line of hunk.lines) {
        if (typeof line !== 'string') continue
        if (line.startsWith('+')) insertions += 1
        else if (line.startsWith('-')) deletions += 1
      }
    }
  }
  return { files: [...files], insertions, deletions }
}

export function writtenElsewhereLine(messages: Message[], fromUuid: string): string | null {
  const written = new Set<string>()
  for (const message of messages.slice(messages.findIndex(candidate => candidate.uuid === fromUuid) + 1)) {
    const result = (message as { toolUseResult?: unknown }).toolUseResult as EditResult | null | undefined
    if (typeof result !== 'object' || result === null || typeof result.filePath !== 'string' || !isRemotePath(result.filePath)) continue
    if (result.type === 'create' || (Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0)) written.add(result.filePath)
  }
  const far = [...written]
  if (far.length === 0) return null
  const named = far.length <= 2 ? far.join(' and ') : `${far[0]}, ${far[1]} and ${far.length - 2} more`
  return `Stays as written on another machine: ${named}.`
}

export function describeFiles(files: string[]): string {
  if (files.length === 0) return ''
  if (files.length === 1) return basename(files[0]!)
  if (files.length === 2) {
    return `${basename(files[0]!)} and ${basename(files[1]!)}`
  }
  return `${basename(files[0]!)} and ${files.length - 1} others`
}
