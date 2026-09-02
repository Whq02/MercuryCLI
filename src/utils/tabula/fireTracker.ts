// ============================================================================
//  TABULA fire tracker — the sent → worked → done lifecycle (session-scoped).
//
//  The loop: ↵ on the /tabula board DROPS a note into
//  the prompt input; when the operator SUBMITS a prompt still carrying that
//  text, the note is FIRED (a journal `fire` event — "this went to the
//  model"); when that turn completes cleanly, the note lands DONE with
//  via:'auto' — green on the board, reversible with one keypress (space).
//
//  Safety bias — never false-done, only stays-open:
//   · fire needs a verbatim carry: the submitted prompt must contain the
//     dropped text. An operator rewrite means no match ⇒ no fire ⇒ no auto.
//   · settle happens ONLY on a clean Stop — query.ts skips stop hooks on API
//     errors, and aborted turns return before them (aborted_streaming /
//     aborted_tools), so an interrupted turn can never settle a note.
//   · in-flight entries from a turn that never settled (abort) are EXPIRED
//     at the next submit, never carried into a different turn's settle.
//   · everything lands as ordinary append-only journal events — the operator
//     can flip any auto-done back open on the board.
//
//  State is module-scoped (one interactive session per process; the hooks in
//  utils/hooks/tabulaFireHooks.ts are the only callers besides the board).
// ============================================================================

import { basename } from 'node:path'
import { bumpHelmLanesVersion } from '../cockpit/helmFocus.js'
import { isTabulaEnabled } from './tabulaGates.js'
import { appendEvents, materializeNotepad, type TabulaEvent } from './tabulaStore.js'

export interface ArmedNote {
  id: string
  /** The exact text dropped into the prompt input (refined or original). */
  insertedText: string
  /** The note's project store dir — journal appends land here. */
  dir: string
  projectName: string
  armedAt: number
}

/** Dropped into the prompt input, awaiting a submit that carries the text. */
let armed: ArmedNote[] = []
/** Fired into the CURRENT turn, awaiting its clean Stop. */
let inFlight: ArmedNote[] = []

const ARM_CAP = 5

/** TEST-ONLY: reset the session state so proofs run hermetic. */
export function resetTabulaFireTrackerForTest(): void {
  armed = []
  inFlight = []
}

/** Board ↵ dropped `insertedText` (note `id`) into the prompt input. */
export function armNoteFire(entry: {
  id: string
  insertedText: string
  dir: string
  projectName: string
}): void {
  if (!isTabulaEnabled()) return
  const text = entry.insertedText.trim()
  if (!text) return
  armed = armed.filter(a => a.id !== entry.id)
  armed.push({ ...entry, insertedText: text, armedAt: Date.now() })
  if (armed.length > ARM_CAP) armed = armed.slice(-ARM_CAP)
}

function appendPerDir(
  entries: ArmedNote[],
  toEvents: (batch: ArmedNote[]) => TabulaEvent[],
): void {
  const byDir = new Map<string, ArmedNote[]>()
  for (const e of entries) {
    const batch = byDir.get(e.dir) ?? []
    batch.push(e)
    byDir.set(e.dir, batch)
  }
  for (const [dir, batch] of byDir) {
    appendEvents(dir, toEvents(batch))
    materializeNotepad(dir, batch[0]?.projectName || basename(dir) || 'project')
  }
  if (byDir.size > 0) bumpHelmLanesVersion()
}

/**
 * A user prompt was submitted. Expire any in-flight entries first (they
 * belonged to a turn that never settled — an abort), then fire every armed
 * note whose dropped text the prompt still carries verbatim.
 */
export function tabulaOnPromptSubmit(prompt: string): void {
  inFlight = []
  if (!isTabulaEnabled() || armed.length === 0) return
  const p = typeof prompt === 'string' ? prompt : ''
  if (!p.trim()) return
  const matched = armed.filter(a => p.includes(a.insertedText))
  if (matched.length === 0) return
  armed = armed.filter(a => !matched.includes(a))
  const stamp = new Date().toISOString()
  appendPerDir(matched, batch => batch.map(a => ({ t: stamp, op: 'fire' as const, id: a.id })))
  inFlight = matched
}

/**
 * The current turn reached a clean Stop — every note fired into it counts as
 * worked and lands done (via:'auto'; green on the board, space reopens).
 */
export function tabulaOnTurnStop(): void {
  if (inFlight.length === 0) return
  const settled = inFlight
  inFlight = []
  if (!isTabulaEnabled()) return
  const stamp = new Date().toISOString()
  appendPerDir(settled, batch =>
    batch.map(a => ({ t: stamp, op: 'done' as const, id: a.id, done: true, via: 'auto' as const })),
  )
}
