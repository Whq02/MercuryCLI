import { useMemo, useRef } from 'react'
import { z } from 'zod/v4'
import { hunkSchema } from '../tools/FileEditTool/types.js'
import { lazySchema } from '../utils/lazySchema.js'
import type { Message, UserMessage } from '../types/message.js'

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
  if (content === '') return []
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

const fileEditResultSchema = lazySchema(() =>
  z.object({
    filePath: z.string(),
    type: z.string().optional(),
    structuredPatch: z.array(hunkSchema()).optional(),
    content: z.string().optional(),
  }),
)

function extractFileEdit(result: unknown): {
  filePath: string
  hunks: Hunk[]
  isNewFile: boolean
} | null {
  const parsed = fileEditResultSchema().safeParse(result)
  if (!parsed.success) return null
  const { filePath, type, structuredPatch, content } = parsed.data
  const isNewFile = type === 'create'
  if (structuredPatch && structuredPatch.length > 0) {
    return { filePath, hunks: structuredPatch, isNewFile }
  }
  if (isNewFile && content !== undefined) {
    const hunks = synthesizeCreateHunks(content)
    if (hunks.length > 0) {
      return { filePath, hunks, isNewFile: true }
    }
  }
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

      const extracted = extractFileEdit(msg.toolUseResult)
      if (!extracted) continue

      if (!cache.currentTurn) {
        cache.currentTurn = {
          turnIndex: ++cache.turnCounter,
          userPromptPreview: '',
          timestamp: msg.timestamp,
          files: new Map(),
        }
      }

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
