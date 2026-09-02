// Incrementally folds transcript messages into per-turn file-diff summaries
// for the diff surface. The cache walks each message index at most once; only
// a rewind (a shorter message array) resets it.

import { useMemo, useRef } from 'react'
import type { Message, UserMessage } from '../types/message.js'

export type TurnFileDiff = {
  filePath: string
  hunks: Hunk[]
  isNewFile: boolean
  linesAdded: number
  linesRemoved: number
}

export type TurnDiff = {
  turnIndex: number
  userPromptPreview: string
  timestamp: string
  files: Map<string, TurnFileDiff>
  stats: {
    filesChanged: number
    linesAdded: number
    linesRemoved: number
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

type InProgressTurn = {
  turnIndex: number
  userPromptPreview: string
  timestamp: string
  files: Map<string, TurnFileDiff>
}

type TurnDiffCache = {
  messagesRef: readonly Message[] | null
  completedTurns: TurnDiff[]
  currentTurn: InProgressTurn | null
  turnCounter: number
  lastProcessedIndex: number
}

function emptyCache(): TurnDiffCache {
  return {
    messagesRef: null,
    completedTurns: [],
    currentTurn: null,
    turnCounter: 0,
    lastProcessedIndex: -1,
  }
}

function extractPreview(message: UserMessage): string {
  const content = message.message.content
  if (typeof content !== 'string') return ''
  if (content.length <= PREVIEW_MAX_CHARS) return content
  return content.slice(0, PREVIEW_MAX_CHARS - 1) + '…'
}

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

function collectEdit(turn: InProgressTurn, result: unknown): void {
  if (typeof result !== 'object' || result === null) return
  const candidate = result as FileEditLikeResult
  if (typeof candidate.filePath !== 'string') return
  const structuredPatch = Array.isArray(candidate.structuredPatch)
    ? (candidate.structuredPatch as Hunk[])
    : []
  const isCreate =
    candidate.type === 'create' && typeof candidate.content === 'string'
  if (structuredPatch.length === 0 && !isCreate) return

  let entry = turn.files.get(candidate.filePath)
  if (!entry) {
    entry = {
      filePath: candidate.filePath,
      hunks: [],
      isNewFile: false,
      linesAdded: 0,
      linesRemoved: 0,
    }
    turn.files.set(candidate.filePath, entry)
  }
  // Once marked new in a turn, a file stays new even if later edited.
  if (isCreate) entry.isNewFile = true

  if (structuredPatch.length === 0 && isCreate) {
    // A created file with an empty patch: synthesise one hunk covering the
    // whole content; a plain newline split, so a trailing newline yields a
    // final empty added line.
    const lines = (candidate.content as string).split('\n')
    entry.hunks.push({
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map(line => '+' + line),
    })
    entry.linesAdded += lines.length
    return
  }

  for (const hunk of structuredPatch) {
    entry.hunks.push(hunk)
    for (const line of hunk.lines) {
      if (line.startsWith('+')) entry.linesAdded += 1
      else if (line.startsWith('-')) entry.linesRemoved += 1
    }
  }
}

function finalizeTurn(turn: InProgressTurn): TurnDiff | null {
  if (turn.files.size === 0) return null
  let linesAdded = 0
  let linesRemoved = 0
  for (const file of turn.files.values()) {
    linesAdded += file.linesAdded
    linesRemoved += file.linesRemoved
  }
  return {
    turnIndex: turn.turnIndex,
    userPromptPreview: turn.userPromptPreview,
    timestamp: turn.timestamp,
    files: turn.files,
    stats: {
      filesChanged: turn.files.size,
      linesAdded,
      linesRemoved,
    },
  }
}

export function useTurnDiffs(messages: readonly Message[]): TurnDiff[] {
  const cacheRef = useRef<TurnDiffCache>(emptyCache())

  return useMemo(() => {
    let cache = cacheRef.current
    // Rewind reset: a shorter array than the walk already consumed discards
    // everything, turn counter included.
    if (
      cache.messagesRef !== messages &&
      messages.length <= cache.lastProcessedIndex
    ) {
      cache = emptyCache()
      cacheRef.current = cache
    }
    if (cache.messagesRef === messages && cache.messagesRef !== null) {
      // Same array identity: nothing new to fold (in-place mutation at an
      // already-processed index is deliberately not re-read).
    }
    cache.messagesRef = messages

    for (let i = cache.lastProcessedIndex + 1; i < messages.length; i++) {
      const message = messages[i]!
      if (message.type !== 'user') continue
      const isToolResult = isToolResultMessage(message)

      if (!isToolResult && !message.isMeta) {
        // A new turn opens; the previous one is kept only when it holds files.
        if (cache.currentTurn) {
          const finished = finalizeTurn(cache.currentTurn)
          if (finished) cache.completedTurns.push(finished)
        }
        cache.turnCounter += 1
        cache.currentTurn = {
          turnIndex: cache.turnCounter,
          userPromptPreview: extractPreview(message),
          timestamp: message.timestamp,
          files: new Map(),
        }
        continue
      }

      // Edits are collected only from ATTACHED tool-use results, and only
      // while a turn is open — a meta message with an attached result still
      // counts.
      if (cache.currentTurn && message.toolUseResult !== undefined) {
        collectEdit(cache.currentTurn, message.toolUseResult)
      }
    }
    cache.lastProcessedIndex = messages.length - 1

    const result: TurnDiff[] = []
    if (cache.currentTurn) {
      const current = finalizeTurn(cache.currentTurn)
      if (current) result.push(current)
    }
    for (let i = cache.completedTurns.length - 1; i >= 0; i--) {
      result.push(cache.completedTurns[i]!)
    }
    return result
  }, [messages])
}
