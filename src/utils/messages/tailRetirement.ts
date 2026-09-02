// ============================================================================
//  tailRetirement — the live tail's ONE release law (attach-road dedup).
//
//  The disease it closes (the operator sighting, entered-from-the-concourse):
//  the same assistant sentence painted TWICE — the settled row with its
//  timestamp and receipt, and a naked caret-bearing copy below in the
//  streaming tail's dress. Two shapes of one gap:
//   · the settle ghost's only release was TEXT EQUALITY against a visible
//     row — but on the daemon road the store holds a watch-cadence PREFIX
//     of the block (the clear coalesces with the final text publish into
//     one read whenever the event loop is busy, the enter-from-concourse
//     paint above all), so the ghost was a stale mid-word prefix that could
//     never equal its own row and stood beside it for the rest of the turn;
//   · a settle-class reply's text is HELD in the tail projection until the
//     turn's result frame (sessionSeat's reveal law for settle messages),
//     and no release applied to PUBLISHED (non-null) text at all — the
//     reply painted twice from row-landing to result.
//
//  THE LAW (mirroring the user-echo identity retirement — one id end to
//  end, echoes retire against the landing row): the tail carries the
//  PROVIDER MESSAGE ID of the text it holds (SessionTailV1.messageId →
//  the store's id channel); a visible assistant row of the CURRENT turn
//  whose message.id equals that identity retires the tail — published text
//  and settled ghost both — the instant the row exists. Rows land whole
//  (the message settles into the transcript before its tool round runs),
//  so an id match guarantees the text row is painted. The text match
//  survives ONLY where no id exists (an old runner's tail file — the
//  mixed-version law), byte-identical to the law it replaces: assistant
//  rows of the current turn, both sides trimmed.
//
//  Pinned by scripts/streaming/prove-attach-tail-identity.ts §2 (the
//  sighting's exact shape, the old-runner control, the held-published
//  release, the human-turn boundary).
// ============================================================================
import type { Message } from '../../types/message.js'
import { isHumanTurn } from '../messagePredicates.js'
import { getAssistantMessageText } from './text.js'

export interface TailReleaseIds {
  /** The identity of the store's fresh/published text (null when unknown). */
  current: string | null
  /** The identity of the settled ghost's text (null when unknown). */
  settled: string | null
}

export interface TailRelease {
  /** A visible current-turn row carries the PUBLISHED text's identity —
   *  the held tail is retired (the row owns the paint). Never true without
   *  an id: live streaming text has no landed row and keeps painting. */
  publishedShown: boolean
  /** The rendered list shows the reply the settled ghost holds — by
   *  identity when the ghost has one, by the trimmed text match otherwise. */
  settledShown: boolean
}

/** One backward walk over the current turn (newest row to the last human
 *  turn), releasing each tail shape the moment its row is visible. */
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
