// ============================================================================
//  concourse/sessionWarmth — the entry's PAINT HINT (paint-from-warmth).
//
//  The board's viewer (SessionMirror) already holds a folded tail of the
//  session it peeks — content literally on screen the frame before the
//  operator's confirming ↵. Entering, the route now flips in the committing
//  dispatch (the entry-gate law) while the connector's fold lands behind it;
//  this store carries that already-paid warmth across the gap so the
//  revealed chat's FIRST frame shows the same tail instead of a blank, and
//  a session with no warmth paints an honest loading row — never a silent
//  blank frame between the board and the chat.
//
//  WARMTH IS A PAINT HINT, NEVER TRUTH: the connector's own fold remains
//  the one transcript truth and ALWAYS replaces these rows (the REPL paints
//  warmth only while the focused records are still empty, and settles the
//  hint the moment they land — the entry road disarms at landing-settled
//  either way). Nothing here is exported, persisted, or fed to history,
//  search, selectors, or the model.
//
//  BOUNDED BY CONSTRUCTION: per session only the TAIL SLICE the mirror
//  painted (WARMTH_TAIL_ROWS newest folded rows), at most WARMTH_SESSIONS
//  sessions kept least-recently-remembered-out (a plain Map re-insert LRU);
//  evicted at fold-complete replace (the settle) and at session close.
//
//  Module-scoped and React-free (the overlayStack store idiom): the mirror
//  publishes, the entry road arms/disarms, the REPL projects via
//  useSyncExternalStore.
// ============================================================================
import type { Message } from '../../types/message.js'

/** The tail slice kept per session — the mirror's painted tail, not a fold. */
export const WARMTH_TAIL_ROWS = 32
/** How many sessions keep a warmth slice (least recently remembered out). */
export const WARMTH_SESSIONS = 8

interface WarmthSlice {
  rows: readonly Message[]
  /** Rows folded but not carried (the cap) — painted as an honest boundary. */
  shed: number
}

const slices = new Map<string, WarmthSlice>()

/** The one-shot entry arm: the entering session's id (and its board title
 *  for the loading row). Armed at the entry DECISION, settled at
 *  landing-settled / records-landed / session mismatch. `coveredSessionId`
 *  names the session whose records the slot STILL holds at the decision
 *  (the commonest hop is C → board → A) — the identity the hint may paint
 *  OVER while the re-point lands behind the committed flip. */
let entering: { sessionId: string; title?: string; coveredSessionId?: string } | null = null

let version = 0
const listeners = new Set<() => void>()
function bump(): void {
  version += 1
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      /* a throwing subscriber never blocks the others */
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

/** The mirror's publish: keep the newest tail slice for this session. A
 *  re-insert refreshes LRU order; the oldest slice falls off past the cap. */
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

/** Fold-complete replace / session close: the hint for this session dies. */
export function evictSessionWarmth(sessionId: string): void {
  const had = slices.delete(sessionId)
  if (had && entering?.sessionId === sessionId) bump()
}

/** The entry decision arms the hint for the session being entered.
 *  `coveredSessionId` is the session holding the slot at the decision (the
 *  pre-entry chat the hint covers until the re-point) — absent/'' when the
 *  slot rests. */
export function armEntryWarmth(sessionId: string, title?: string, coveredSessionId?: string): void {
  entering = {
    sessionId,
    ...(title !== undefined ? { title } : {}),
    ...(coveredSessionId !== undefined && coveredSessionId !== '' ? { coveredSessionId } : {}),
  }
  bump()
}

/** Landing settled (either way), records landed, or the slot moved on: the
 *  entry hint stands down. With a session id, only that session's arm
 *  settles (a newer entry's arm survives an older landing's settle). */
export function settleEntryWarmth(sessionId?: string): void {
  if (entering === null) return
  if (sessionId !== undefined && entering.sessionId !== sessionId) return
  entering = null
  bump()
}

export interface EnteringWarmth {
  sessionId: string
  title?: string
  /** The session the slot held at the decision — the identity the hint
   *  paints over until the re-point (the covered-slot law). */
  coveredSessionId?: string
  rows: readonly Message[]
  shed: number
}

/** The armed entry's warmth, if any: the remembered tail slice (rows may be
 *  empty — a cold entry paints the loading row instead). Null while no
 *  entry is armed. */
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

/**
 * THE PAINT SELECTION (pure — the never-blank law's row half), keyed by THE
 * MOUNTING IDENTITY (the identity law): warmth answers only for the session
 * that earned it. `focusedSessionId` is the session the mount shows ('' =
 * the slot rests, the landing window):
 *  - the COVERED identity (the slot the decision painted over, not yet
 *    re-pointed): the armed warmth covers its records — they are not this
 *    entry's truth (cold → empty rows; the loading line is the cover);
 *  - any OTHER real identity: its own records, never another's warmth (the
 *    cross-session bleed);
 *  - the ARMED identity or the resting slot: the focused records when any
 *    exist (the truth always wins); the warm tail while they are still
 *    empty. Plain `messages` identity otherwise, so the ordinary chat path
 *    never re-renders over this seam.
 * The COLD side of never-blank is entryLoadingLineOf's — a chrome line, not
 * a conversation row (the message grammar has no honest "loading" row:
 * 'info' system rows paint only in verbose).
 */
export function paintedTranscriptOf(messages: Message[], warmth: EnteringWarmth | null, focusedSessionId = ''): Message[] {
  if (warmth === null) return messages
  if (focusedSessionId !== '' && focusedSessionId === warmth.coveredSessionId) {
    return warmth.rows.length > 0 ? [...warmth.rows] : []
  }
  if (focusedSessionId !== '' && focusedSessionId !== warmth.sessionId) return messages
  if (messages.length > 0 || warmth.rows.length === 0) return messages
  return [...warmth.rows]
}

/** The honest loading line for a COLD entry (armed, no warmth, records not
 *  yet landed) — pure; null whenever any content can paint instead. Keyed
 *  by the same mounting identity: over the COVERED slot the line shows even
 *  beside records (they are the pre-entry session's, not this entry's
 *  truth); a third identity never wears another entry's line. */
export function entryLoadingLineOf(warmth: EnteringWarmth | null, recordsEmpty: boolean, focusedSessionId = ''): string | null {
  if (warmth === null || warmth.rows.length > 0) return null
  const covered = focusedSessionId !== '' && focusedSessionId === warmth.coveredSessionId
  if (!covered && focusedSessionId !== '' && focusedSessionId !== warmth.sessionId) return null
  if (!covered && !recordsEmpty) return null
  return `opening ${warmth.title !== undefined && warmth.title !== '' ? warmth.title : 'the session'} — loading the conversation…`
}

/** Proof seam — module state is process-lifetime. */
export function _resetSessionWarmthForTesting(): void {
  slices.clear()
  entering = null
  bump()
}
