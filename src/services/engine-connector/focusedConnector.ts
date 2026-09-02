// ============================================================================
//  engine-connector/focusedConnector — THE FOCUSED CHAT's connector slot.
//
//  Every session is a full chat; the one on screen is the focused chat, and
//  this slot holds ITS connector. The face reads the slot (or rides
//  useSessionConnector) and never cares which session stands behind it: a
//  daemon-hosted session's connector takes the slot when the operator
//  enters one (New Session births it, a board row or a resume enters it).
//  Re-pointing the slot IS the hop, as far as the face is concerned.
//
//  THE ONE-DOOR LAW (Law 9: the session is the unit; every screen is a
//  view): a fresh boot has NO chat. While no session holds the slot it
//  RESTS on the no-session connector — not a chat, never a session, every
//  reader door honest and empty, every send refused — and the root REPL
//  yields to the boot menu. A chat starts to exist only when entered.
//  There is no other kind of chat.
// ============================================================================
import { logForDebugging } from '../../utils/debug.js'
import { noSessionConnector } from './noSessionConnector.js'
import type { EngineConnectorV1 } from './types.js'

let focused: EngineConnectorV1 | null = null

// THE HOP FENCE (the kinetic switch-fence law: the LAST-CHOSEN session owns
// the commit). Every hop claims the next epoch before its load; a hop whose
// load lands after a newer hop was chosen never re-points the slot — an
// operator who hops A → B → C within a few hundred milliseconds lands on C
// even when B's transcript takes longer to read.
let hopEpoch = 0
export function claimHopEpoch(): number {
  hopEpoch += 1
  return hopEpoch
}
export function hopEpochIsCurrent(epoch: number): boolean {
  return epoch === hopEpoch
}
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) {
    try {
      l()
    } catch (e) {
      logForDebugging(
        `[engine-connector] focused listener threw (ignored): ${e}`,
      )
    }
  }
}

/** The focused chat's connector — always answers: the session's own while
 *  one holds the slot, the resting no-session connector otherwise. */
export function getFocusedSessionConnector(): EngineConnectorV1 {
  return focused ?? noSessionConnector()
}

/** Does a session hold the slot? False while no chat is open (a fresh
 *  boot, the last chat closed) — the face's one "no chat" truth. */
export function hasFocusedSession(): boolean {
  return focused !== null
}

/** Point the slot at a session's connector. */
export function setFocusedSessionConnector(next: EngineConnectorV1): void {
  const before = getFocusedSessionConnector()
  focused = next
  if (getFocusedSessionConnector() === before) return
  emit()
}

/** Close the focused chat: the slot rests on no session. The close is the
 *  operator's newest choice, so it claims the epoch — an older hop's late
 *  load never re-points the slot at a chat that was just closed. */
export function releaseFocusedSessionConnector(): void {
  claimHopEpoch()
  if (focused === null) return
  focused = null
  emit()
}

export function subscribeFocusedSessionConnector(
  listener: () => void,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The slot's facts changed WITHOUT a re-point — the ground moved under a
 *  resting slot (its workspace door reads the screen's cwd live). Pulse the
 *  slot's subscribers so every reader door re-reads; without it the chat's
 *  chrome painted the boot folder until the next unrelated render. */
export function emitFocusedSessionConnectorChanged(): void {
  emit()
}

// THE LANDING GATE: a birth, a hop or a resume is IN FLIGHT between its
// door's call and the slot's re-point (an admit round trip, a bounded first
// read). The face's "no chat ⇒ the boot menu" yield reads this so it never
// covers a chat that is a few milliseconds from landing (an armed
// '/resume <id>' from the boot menu's Continue row is exactly that case).
// Both edges pulse the slot's subscribers.
let landings = 0
export function landingInFlight(): boolean {
  return landings > 0
}
export async function withLanding<T>(landing: Promise<T>): Promise<T> {
  landings += 1
  emit()
  try {
    return await landing
  } finally {
    landings -= 1
    emit()
  }
}

/**
 * Compose a door subscription THROUGH the slot: the listener rides the
 * focused connector's door, re-attaches when the slot re-points (a hop),
 * and hears the re-point itself. The returned subscribe function is
 * module-stable, so face components can hand it to useSyncExternalStore.
 */
export function subscribeThroughFocused(
  attach: (connector: EngineConnectorV1, listener: () => void) => () => void,
): (listener: () => void) => () => void {
  return listener => {
    let inner = attach(getFocusedSessionConnector(), listener)
    const outer = subscribeFocusedSessionConnector(() => {
      inner()
      inner = attach(getFocusedSessionConnector(), listener)
      listener()
    })
    return () => {
      outer()
      inner()
    }
  }
}

/** Proof seam — the slot is process-lifetime. */
export function _resetFocusedSessionConnectorForTesting(): void {
  focused = null
  landings = 0
  emit()
}
