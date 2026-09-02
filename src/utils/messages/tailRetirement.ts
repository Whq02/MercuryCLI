import type { Message } from '../../types/message.js'
import { isHumanTurn } from '../messagePredicates.js'
import { getAssistantMessageText } from './text.js'

export interface TailReleaseIds {
  current: string | null
  settled: string | null
}

export interface TailRelease {
  publishedShown: boolean
  settledShown: boolean
}

export function computeTailRelease(
  visible: readonly Message[],
  ids: TailReleaseIds,
  settledRaw: string | null,
): TailRelease {
  const settledText = settledRaw === null ? null : settledRaw.trim() || null
  const wantPublished = ids.current !== null
  const wantSettled = settledText !== null
  let publishedShown = false
  let settledShown = false
  if (!wantPublished && !wantSettled) return { publishedShown, settledShown }
  for (let i = visible.length - 1; i >= 0; i--) {
    const row = visible[i]!
    if (isHumanTurn(row)) break
    if (row.type !== 'assistant') continue
    const m = (row as { message?: { id?: unknown } }).message
    const rowId = typeof m?.id === 'string' && m.id !== '' ? m.id : null
    if (wantPublished && rowId !== null && rowId === ids.current) publishedShown = true
    if (wantSettled && !settledShown) {
      if (ids.settled !== null) {
        if (rowId !== null && rowId === ids.settled) settledShown = true
      } else if (getAssistantMessageText(row) === settledText) {
        settledShown = true
      }
    }
    if ((publishedShown || !wantPublished) && (settledShown || !wantSettled)) break
  }
  return { publishedShown, settledShown }
}
