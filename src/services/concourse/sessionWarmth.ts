import type { Message } from '../../types/message.js'

export const WARMTH_TAIL_ROWS = 32
export const WARMTH_SESSIONS = 8

interface WarmthSlice {
  rows: readonly Message[]
  shed: number
}

const slices = new Map<string, WarmthSlice>()

let entering: { sessionId: string; title?: string; coveredSessionId?: string } | null = null

let version = 0
const listeners = new Set<() => void>()
function bump(): void {
  version += 1
  for (const cb of listeners) {
    try {
      cb()
    } catch {
    }
  }
}

export function subscribeSessionWarmth(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function sessionWarmthVersion(): number {
  return version
}

export function rememberSessionWarmth(sessionId: string, rows: readonly Message[], shedBefore: number): void {
  if (rows.length === 0) return
  const tail = rows.slice(-WARMTH_TAIL_ROWS)
  const shed = shedBefore + (rows.length - tail.length)
  slices.delete(sessionId)
  slices.set(sessionId, { rows: tail, shed })
  for (const key of slices.keys()) {
    if (slices.size <= WARMTH_SESSIONS) break
    slices.delete(key)
  }
  if (entering?.sessionId === sessionId) bump()
}

export function evictSessionWarmth(sessionId: string): void {
  const had = slices.delete(sessionId)
  if (had && entering?.sessionId === sessionId) bump()
}

export function armEntryWarmth(sessionId: string, title?: string, coveredSessionId?: string): void {
  entering = {
    sessionId,
    ...(title !== undefined ? { title } : {}),
    ...(coveredSessionId !== undefined && coveredSessionId !== '' ? { coveredSessionId } : {}),
  }
  bump()
}

export function settleEntryWarmth(sessionId?: string): void {
  if (entering === null) return
  if (sessionId !== undefined && entering.sessionId !== sessionId) return
  entering = null
  bump()
}

export interface EnteringWarmth {
  sessionId: string
  title?: string
  coveredSessionId?: string
  rows: readonly Message[]
  shed: number
}

export function enteringWarmth(): EnteringWarmth | null {
  if (entering === null) return null
  const slice = slices.get(entering.sessionId)
  return {
    sessionId: entering.sessionId,
    ...(entering.title !== undefined ? { title: entering.title } : {}),
    ...(entering.coveredSessionId !== undefined ? { coveredSessionId: entering.coveredSessionId } : {}),
    rows: slice?.rows ?? [],
    shed: slice?.shed ?? 0,
  }
}

export function paintedTranscriptOf(messages: Message[], warmth: EnteringWarmth | null, focusedSessionId = ''): Message[] {
  if (warmth === null) return messages
  if (focusedSessionId !== '' && focusedSessionId === warmth.coveredSessionId) {
    return warmth.rows.length > 0 ? [...warmth.rows] : []
  }
  if (focusedSessionId !== '' && focusedSessionId !== warmth.sessionId) return messages
  if (messages.length > 0 || warmth.rows.length === 0) return messages
  return [...warmth.rows]
}

export function entryLoadingLineOf(warmth: EnteringWarmth | null, recordsEmpty: boolean, focusedSessionId = ''): string | null {
  if (warmth === null || warmth.rows.length > 0) return null
  const covered = focusedSessionId !== '' && focusedSessionId === warmth.coveredSessionId
  if (!covered && focusedSessionId !== '' && focusedSessionId !== warmth.sessionId) return null
  if (!covered && !recordsEmpty) return null
  return `opening ${warmth.title !== undefined && warmth.title !== '' ? warmth.title : 'the session'} — loading the conversation…`
}

export function _resetSessionWarmthForTesting(): void {
  slices.clear()
  entering = null
  bump()
}
