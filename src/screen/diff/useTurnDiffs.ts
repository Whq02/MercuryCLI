import { useMemo, useRef } from 'react'
import { isRecord } from '../../platform/primitives/isRecord.js'
import type { Message, UserMessage } from '../../engine/message-shapes/message.js'

type LineChanges = Record<'linesAdded' | 'linesRemoved', number>

export type TurnDiff = {
  turnIndex: number
  userPromptPreview: string
  timestamp: string
  files: Map<
    string,
    LineChanges & {
      filePath: string
      hunks: Hunk[]
      isNewFile: boolean
    }
  >
  stats: LineChanges & {
    filesChanged: number
  }
}

type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

const PREVIEW_MAX_CHARS = 30

function isToolResultMessage(message: UserMessage): boolean {
  if (message.toolUseResult !== undefined) return true
  const content = message.message.content
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content[0]?.type === 'tool_result'
  )
}

type FileEditLikeResult = {
  filePath?: unknown
  structuredPatch?: unknown
  type?: unknown
  content?: unknown
}

type TurnFileEntry = LineChanges & {
  filePath: string
  hunks: Hunk[]
  isNewFile: boolean
}

type MutableTurn = {
  turnIndex: number
  userPromptPreview: string
  timestamp: string
  files: Map<string, TurnFileEntry>
}

type TurnDiffCache = {
  messagesRef: readonly Message[]
  completedTurns: TurnDiff[]
  currentTurn: MutableTurn | null
  turnCounter: number
  lastProcessedIndex: number
}

function previewPrompt(content: UserMessage['message']['content']): string {
  if (typeof content !== 'string') return ''
  const collapsed = content.trim().replace(/\s+/g, ' ')
  if (collapsed.length <= PREVIEW_MAX_CHARS) return collapsed
  return `${collapsed.slice(0, PREVIEW_MAX_CHARS - 1)}…`
}

function countHunkLines(hunks: readonly Hunk[]): LineChanges {
  let linesAdded = 0
  let linesRemoved = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) linesAdded++
      else if (line.startsWith('-')) linesRemoved++
    }
  }
  return { linesAdded, linesRemoved }
}

function synthesizeCreateHunks(content: string): Hunk[] {
  const lines = content.split('\n')
  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map(line => `+${line}`),
    },
  ]
}

function hunkOf(entry: unknown): Hunk {
  const record = isRecord(entry) ? entry : {}
  const count = (value: unknown): number => (typeof value === 'number' ? value : 0)
  return {
    oldStart: count(record.oldStart),
    oldLines: count(record.oldLines),
    newStart: count(record.newStart),
    newLines: count(record.newLines),
    lines: Array.isArray(record.lines) ? record.lines.filter((line): line is string => typeof line === 'string') : [],
  }
}

function extractFileEdit(result: unknown): {
  filePath: string
  hunks: Hunk[]
  isNewFile: boolean
} | null {
  if (!isRecord(result)) return null
  const { filePath, type, structuredPatch, content }: FileEditLikeResult = result
  if (typeof filePath !== 'string') return null
  const patch = Array.isArray(structuredPatch) ? structuredPatch.map(hunkOf) : []
  const created = type === 'create' && typeof content === 'string' ? content : null
  if (patch.length > 0) return { filePath, hunks: patch, isNewFile: created !== null }
  if (created !== null) return { filePath, hunks: synthesizeCreateHunks(created), isNewFile: true }
  return null
}

function finalizeTurn(turn: MutableTurn): TurnDiff {
  let linesAdded = 0
  let linesRemoved = 0
  const files = new Map<string, TurnFileEntry>()
  for (const [key, file] of turn.files) {
    linesAdded += file.linesAdded
    linesRemoved += file.linesRemoved
    files.set(key, { ...file, hunks: [...file.hunks] })
  }
  return {
    turnIndex: turn.turnIndex,
    userPromptPreview: turn.userPromptPreview,
    timestamp: turn.timestamp,
    files,
    stats: {
      filesChanged: files.size,
      linesAdded,
      linesRemoved,
    },
  }
}

export function useTurnDiffs(messages: readonly Message[]): TurnDiff[] {
  const cacheRef = useRef<TurnDiffCache>({
    messagesRef: messages,
    completedTurns: [],
    currentTurn: null,
    turnCounter: 0,
    lastProcessedIndex: -1,
  })

  return useMemo(() => {
    const cache = cacheRef.current
    if (messages !== cache.messagesRef && messages.length <= cache.lastProcessedIndex) {
      cache.completedTurns = []
      cache.currentTurn = null
      cache.turnCounter = 0
      cache.lastProcessedIndex = -1
    }
    cache.messagesRef = messages

    for (let i = cache.lastProcessedIndex + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg || msg.type !== 'user') continue

      if (!isToolResultMessage(msg)) {
        if (msg.isMeta) continue
        if (cache.currentTurn && cache.currentTurn.files.size > 0) {
          cache.completedTurns.push(finalizeTurn(cache.currentTurn))
        }
        cache.currentTurn = {
          turnIndex: ++cache.turnCounter,
          userPromptPreview: previewPrompt(msg.message.content),
          timestamp: msg.timestamp,
          files: new Map(),
        }
        continue
      }

      if (!cache.currentTurn) continue
      const extracted = extractFileEdit(msg.toolUseResult)
      if (!extracted) continue

      const delta = countHunkLines(extracted.hunks)
      const existing = cache.currentTurn.files.get(extracted.filePath)
      if (existing) {
        existing.hunks.push(...extracted.hunks)
        existing.linesAdded += delta.linesAdded
        existing.linesRemoved += delta.linesRemoved
        if (extracted.isNewFile) existing.isNewFile = true
      } else {
        cache.currentTurn.files.set(extracted.filePath, {
          filePath: extracted.filePath,
          hunks: [...extracted.hunks],
          isNewFile: extracted.isNewFile,
          linesAdded: delta.linesAdded,
          linesRemoved: delta.linesRemoved,
        })
      }
    }

    cache.lastProcessedIndex = messages.length - 1

    const result: TurnDiff[] = []
    if (cache.currentTurn && cache.currentTurn.files.size > 0) {
      result.push(finalizeTurn(cache.currentTurn))
    }
    for (let i = cache.completedTurns.length - 1; i >= 0; i--) {
      const turn = cache.completedTurns[i]
      if (turn) result.push(turn)
    }
    return result
  }, [messages])
}
