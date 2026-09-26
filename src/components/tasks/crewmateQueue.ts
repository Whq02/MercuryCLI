import type { Message, UserMessage } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { crewmateLineRefusedNote, crewmateLineStrandedNote } from '../../utils/cockpit/crewmateWords.js'

export const CREWMATE_QUEUE_STRAND_MS = 12_000

export type CrewmateQueuedLine = {
  text: string
  row: UserMessage
  refused: string | null
  queuedAt: number
  strandedRow: UserMessage | null
}

export type CrewmateQueueFacts = { running: boolean; endedAt: number | null } | null

const byCrewmate = new Map<string, CrewmateQueuedLine[]>()
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

function queuedRow(content: string): UserMessage {
  return { ...createUserMessage({ content }), queued: true }
}

export function queueCrewmateLine(taskId: string, text: string): UserMessage {
  const row = queuedRow(text)
  const lines = byCrewmate.get(taskId) ?? []
  byCrewmate.set(taskId, [...lines, { text, row, refused: null, queuedAt: Date.now(), strandedRow: null }])
  notify()
  return row
}

export function refuseCrewmateLine(taskId: string, text: string, name: string, why: string): void {
  const lines = byCrewmate.get(taskId) ?? []
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (line.text !== text || line.refused !== null) continue
    const next = [...lines]
    next[index] = { ...line, refused: why, row: queuedRow(`${text}\n${crewmateLineRefusedNote(name, why)}`) }
    byCrewmate.set(taskId, next)
    notify()
    return
  }
}

export function pruneLandedCrewmateLines(taskId: string, landedTexts: readonly string[]): void {
  const lines = byCrewmate.get(taskId)
  if (lines === undefined || lines.length === 0) return
  const kept = lines.filter(line => line.refused !== null || !landedTexts.some(landed => landed.includes(line.text)))
  if (kept.length === lines.length) return
  byCrewmate.set(taskId, kept)
  notify()
}

export function crewmateLineStranded(line: Pick<CrewmateQueuedLine, 'refused' | 'queuedAt'>, facts: CrewmateQueueFacts, nowMs: number): boolean {
  if (line.refused !== null || facts === null || facts.running) return false
  const since = Math.max(line.queuedAt, facts.endedAt ?? line.queuedAt)
  return nowMs - since >= CREWMATE_QUEUE_STRAND_MS
}

export function crewmateQueuedRows(taskId: string, facts: CrewmateQueueFacts, name: string, nowMs: number): Message[] {
  const lines = byCrewmate.get(taskId)
  if (lines === undefined || lines.length === 0) return []
  return lines.map(line => {
    if (!crewmateLineStranded(line, facts, nowMs)) return line.row
    if (line.strandedRow === null) line.strandedRow = queuedRow(`${line.text}\n${crewmateLineStrandedNote(name)}`)
    return line.strandedRow
  })
}

export function crewmateQueueSize(taskId: string): number {
  return byCrewmate.get(taskId)?.length ?? 0
}

export function crewmateQueueVersion(): number {
  return version
}

export function subscribeCrewmateQueue(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetCrewmateQueueForTest(): void {
  byCrewmate.clear()
  notify()
}
