import type { Message } from '../../types/message.js'

export interface TailReleaseIds {
  current: string | null
  settled: string | null
}

export interface TailRelease {
  publishedShown: boolean
  settledShown: boolean
}

export function computeTailRelease(visible: readonly Message[], ids: TailReleaseIds): TailRelease {
  const wantPublished = ids.current !== null
  const wantSettled = ids.settled !== null
  let publishedShown = false
  let settledShown = false
  if (!wantPublished && !wantSettled) return { publishedShown, settledShown }
  for (let i = visible.length - 1; i >= 0; i--) {
    const row = visible[i]!
    if (row.type !== 'assistant') continue
    const m = (row as { message?: { id?: unknown; content?: unknown } }).message
    const rowId = typeof m?.id === 'string' && m.id !== '' ? m.id : null
    if (rowId === null || !carriesText(m?.content)) continue
    if (wantPublished && rowId === ids.current) publishedShown = true
    if (wantSettled && rowId === ids.settled) settledShown = true
    if ((publishedShown || !wantPublished) && (settledShown || !wantSettled)) break
  }
  return { publishedShown, settledShown }
}

function carriesText(content: unknown): boolean {
  if (typeof content === 'string') return content !== ''
  if (!Array.isArray(content)) return false
  return content.some(block => {
    const b = block as { type?: unknown; text?: unknown } | null
    return b?.type === 'text' && typeof b.text === 'string' && b.text !== ''
  })
}
