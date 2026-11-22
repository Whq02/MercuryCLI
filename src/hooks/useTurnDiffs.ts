import { useMemo, useRef } from 'react'
import type { Message, UserMessage } from '../types/message.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type LineChanges = Record<'linesAdded' | 'linesRemoved', number>

export type TurnDiff = Unbuilt

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

export function useTurnDiffs(messages: readonly Message[]): TurnDiff[] {
  return notBuilt('src/hooks/useTurnDiffs.ts:147')
}
