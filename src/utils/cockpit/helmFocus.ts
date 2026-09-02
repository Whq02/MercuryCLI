// ============================================================================
//  utils/cockpit/helmFocus — the A2.2 Phase-3 cockpit FOCUS MODEL store.
//
//  One tiny module store (observable + useSyncExternalStore, Mercury's
//  module-state pattern) shared by three parties:
//    · PromptInput — the ONE input owner. Its useInput consumes Tab/↑↓/↵/esc
//      while a rail holds focus (and its text-buffer `focus` prop gates off
//      helm focus, so nav keys never leak into the buffer — spec risk #2).
//    · HelmLanesRail / HelmTelemetryRail — render the focus ring + cursor
//      caret, and PUBLISH their selectable row models here each render (the
//      rails already compute the rows; publishing avoids re-deriving them in
//      the input layer and the drift that would bring).
//    · Proofs — the cycle order, cursor clamp, and row→action mapping are
//      pure functions on this module, provable without React.
//
//  Focus is 'prompt' by default and ALWAYS returns there on esc / after an
//  Enter action — the rails are a glance-and-drill surface, not a mode.
// ============================================================================

import { fluxMark } from '../flux/fluxProbe.js'
import { refuseGestureWhileModal } from '../permissions/permissionFocus.js'

export type HelmPane = 'prompt' | 'lanes' | 'telemetry'

/** A selectable rail row: what Enter should do, plus the label for a11y/tests.
 *  `teammate` rows drill the center transcript (enterTeammateView); `command`
 *  rows open the owning surface via the prompt's slash-command submit;
 *  `console` rows enter the Helm console's compose mode IN PLACE (focus stays
 *  on the telemetry rail — the one rail action that is a mode, not a drill). */
export type HelmRow =
  | { kind: 'teammate'; id: string; label: string }
  | { kind: 'command'; command: string; label: string }
  | { kind: 'console'; label: string }
  | { kind: 'minerva'; label: string }
 // the CREW root — the main Mercury conversation as a permanent
  // rail target. ↵/click RETURNS to main (exitTeammateView); it never stops
  // child work and is never a task row.
  | { kind: 'main'; label: string }

export type HelmRowAction =
  | { type: 'teammate'; id: string }
  | { type: 'command'; command: string }
  | { type: 'console' }
  | { type: 'minerva' }
  | { type: 'main' }

/** ONE signature for a row (publish compare + the rails' publish effects) —
 *  three call sites would otherwise inline this expression; a new row kind must never
 *  be able to drift between them. */
export function helmRowSig(r: HelmRow): string {
  const head =
    r.kind === 'teammate'
      ? `t:${r.id}`
      : r.kind === 'command'
        ? `c:${r.command}`
        : r.kind === 'minerva'
          ? 'k:minerva'
          : r.kind === 'main'
              ? 'k:main'
              : 'k:console'
  return `${head}:${r.label}`
}

/** Whether the telemetry rail is MOUNTED under the current railPlan — stamped
 *  by FullscreenLayout each cockpit render (center-first shed,).
 *  Module state, read only at cycle time: no store notify needed — a plan flip
 *  re-renders the layout anyway, and the P2 focus-hygiene effect already
 *  returns focus to the prompt when a focused rail unmounts. */
let telemetryAvailable = true
export function setHelmTelemetryAvailable(on: boolean): void {
  telemetryAvailable = on
}
export function isHelmTelemetryAvailable(): boolean {
  return telemetryAvailable
}

// ── prompt-emptiness observable (SessionTabs' state-aware hint) ──
// The ⌥←/→ session flip only fires on an EMPTY prompt (with text it's
// word-nav), so a STANDING "⌥←→ flip" hint lies the moment the operator
// types. PromptInput (the one input owner) stamps emptiness transitions here;
// SessionTabs subscribes and only advertises the chord while it's actually
// armed — honesty by state, not by parenthetical. Same module-store
// pattern as helm focus (notify only on flips: typing costs nothing).
let promptEmpty = true
const promptEmptyListeners = new Set<() => void>()
export function setPromptEmpty(empty: boolean): void {
  if (promptEmpty === empty) return
  promptEmpty = empty
  for (const l of promptEmptyListeners) l()
}
export function isPromptEmpty(): boolean {
  return promptEmpty
}
export function subscribePromptEmpty(listener: () => void): () => void {
  promptEmptyListeners.add(listener)
  return () => promptEmptyListeners.delete(listener)
}

// ── session-rail row reserve TORATION R1-gate) ──────────────
// SessionTabs is CONDITIONAL cockpit chrome: one row when it paints (other
// berths to tab between, or the persistent Concourse action), zero when it
// sheds. A height budget that subtracts a chrome CONSTANT from terminalRows
// (the ask-card content budget) cannot know the shed state, so the rail
// publishes the row count it actually paints and budgets subtract live
// truth. Same module-store pattern as promptEmpty (notify only on flips).
let sessionRailRows = 0
const sessionRailRowsListeners = new Set<() => void>()
export function setSessionRailRows(rows: number): void {
  if (sessionRailRows === rows) return
  sessionRailRows = rows
  for (const l of sessionRailRowsListeners) l()
}
export function getSessionRailRows(): number {
  return sessionRailRows
}
export function subscribeSessionRailRows(listener: () => void): () => void {
  sessionRailRowsListeners.add(listener)
  return () => sessionRailRowsListeners.delete(listener)
}

/** Tab cycle: prompt → lanes → telemetry → prompt — telemetry SKIPPED when the
 *  railPlan folded it into the lanes rail. Pure given the stamp (proved). */
export function nextHelmPane(p: HelmPane): HelmPane {
  if (p === 'prompt') return 'lanes'
  if (p === 'lanes') return telemetryAvailable ? 'telemetry' : 'prompt'
  return 'prompt'
}

/** The Enter action for a row (null for none — an empty rail). Pure (proved). */
export function helmRowAction(row: HelmRow | undefined): HelmRowAction | null {
  if (!row) return null
  if (row.kind === 'teammate') return { type: 'teammate', id: row.id }
  if (row.kind === 'console') return { type: 'console' }
  if (row.kind === 'minerva') return { type: 'minerva' }
  if (row.kind === 'main') return { type: 'main' }
  return { type: 'command', command: row.command }
}

type RailPane = 'lanes' | 'telemetry'

let focus: HelmPane = 'prompt'
const cursor: Record<RailPane, number> = { lanes: 0, telemetry: 0 }
// STABLE INTERACTION IDENTITY: the cursor's true anchor is the
// ROW (its helmRowSig), not its position. The rails' row models rebuild from
// live stores (runs, workflows, presence, TABULA bumps) — rows
// appearing or vanishing ABOVE a raw index silently retargeted the cursor,
// and ↵ then activated whatever now sat at that position (a RUNS row carries
// a per-task command — a retarget opens the WRONG task). publish re-anchors
// the index by signature; the clamp survives only as the vanished-row
// fallback.
const cursorSig: Record<RailPane, string> = { lanes: '', telemetry: '' }
const rows: Record<RailPane, HelmRow[]> = { lanes: [], telemetry: [] }
const rowsSig: Record<RailPane, string> = { lanes: '', telemetry: '' }
let version = 0
// Per-pane versions so each rail can snapshot ONLY its own slice: a ↑/↓ in
// the lanes rail must not re-render the telemetry rail (and re-run its
// quota/trace/substrate snapshot reads) — they would otherwise share the one global
// counter. The global `version` stays bumped on EVERY notify: PromptInput's
// consume effects (activation/command dispatch) and focus gating ride it.
const paneVersion: Record<RailPane, number> = { lanes: 0, telemetry: 0 }
const listeners = new Set<() => void>()

function notify(): void {
  version++
  for (const l of listeners) l()
}

/** A pane-scoped mutation (cursor move, row publish) — bumps that pane only. */
function notifyPane(pane: RailPane): void {
  paneVersion[pane]++
  fluxMark(`helm:pane:${pane}`) // probe-gated ring stamp (off ⇒ no-op)
  notify()
}

/** A focus transition — the ring moves between panes, so both rails repaint. */
function notifyFocus(): void {
  paneVersion.lanes++
  paneVersion.telemetry++
  fluxMark('helm:focus') // probe-gated ring stamp (off ⇒ no-op)
  notify()
}

// ---- click parity (operator polish pass): a rail row CLICK requests the
// same activation the keyboard ↵ performs. The rail components can't reach
// PromptInput's dispatch closures (onSubmit / enterTeammateView), so the
// click stores a pending request here and notifies; PromptInput consumes it
// in an effect — ONE dispatcher, two input paths (the C0 audit lesson).
// Stable interaction identity: the pending request is captured as the clicked row's
// SIGNATURE at request time — PromptInput's consume effect runs a render
// later, and a live-store publish in between would otherwise retarget the raw index
// to a different row. A vanished row resolves to null (no-op): never
// activate something the operator didn't click.
let pendingActivation: { pane: RailPane; sig: string } | null = null

/** Click parity for rails whose rows are built as inline expressions (the
 *  telemetry rail,): activate by the row's UNIQUE label instead of
 *  a positional index — labels are the row keys, so the binding survives row
 *  shifts and needs no index hoisting at the call site. No match ⇒ no-op. */
export function requestHelmRowActivationByLabel(pane: RailPane, label: string): void {
  const i = rows[pane].findIndex(r => r.label === label)
  if (i >= 0) requestHelmRowActivation(pane, i)
}

/** The activation gesture's name for the modal-focus refusal notice. */
function gestureName(row: HelmRow | undefined): string {
  if (row !== undefined && 'command' in row && typeof row.command === 'string') {
    return row.command
  }
  return 'that surface'
}

export function requestHelmRowActivation(pane: RailPane, index: number): void {
  // Modal permission focus (block E): the gesture is refused AT ENTRY —
  // never parked to pop after the card resolves. Selection (setHelmCursor)
  // stays free; ACTIVATION is what opens/queues a surface.
  if (refuseGestureWhileModal(gestureName(rows[pane][index]))) return
  const row = rows[pane][index]
  if (!row) return
  pendingActivation = { pane, sig: helmRowSig(row) }
  notify()
}

/** The pointer path's identity-true verbs: a row component that
 *  knows its OWN signature selects/activates by it, so a publish between the
 *  render the pointer saw and the click event can never retarget the gesture.
 *  A vanished row is a no-op. */
export function setHelmCursorBySig(pane: RailPane, sig: string): void {
  const i = rows[pane].findIndex(r => helmRowSig(r) === sig)
  if (i >= 0) setHelmCursor(pane, i)
}

export function requestHelmRowActivationBySig(pane: RailPane, sig: string): void {
  const row = rows[pane].find(r => helmRowSig(r) === sig)
  if (row === undefined) return
  // Modal permission focus (block E): refuse at entry, never park.
  if (refuseGestureWhileModal(gestureName(row))) return
  pendingActivation = { pane, sig }
  notify()
}

/** Consume + resolve the pending click activation (null when none). */
export function consumeHelmActivation(): HelmRowAction | null {
  if (!pendingActivation) return null
  const { pane, sig } = pendingActivation
  pendingActivation = null
  const row = rows[pane].find(r => helmRowSig(r) === sig)
  return helmRowAction(row)
}

// ---- generic command dispatch (trust-cockpit W4): the same one-dispatcher
// shape as the click channel, for surfaces that aren't rail rows — a Deck
// NEXT-row ↵/click, a SessionTabs tab click. The surface stores the slash
// command here and notifies; PromptInput's consume effect (the ONE submit
// dispatcher) drains it alongside consumeHelmActivation. Last-write-wins by
// design: these are single operator gestures, never a queue.
let pendingCommand: string | null = null

export function requestCommandDispatch(command: string): void {
  // Modal permission focus (block E): refuse at entry, never park.
  if (refuseGestureWhileModal(command)) return
  pendingCommand = command
  notify()
}

/** Consume the pending command dispatch (null when none). */
export function consumeCommandDispatch(): string | null {
  const c = pendingCommand
  pendingCommand = null
  return c
}

// ---- prompt PREFILL channel (action-honesty pass): the same
// one-dispatcher shape as the command channel, but the consumer INSERTS the
// text at the prompt cursor instead of submitting — the command-palette
// safety semantics (reversible, never auto-runs, never clobbers typed
// input). For surfaces whose advertised key BEGINS an arg-bearing workflow
// (RealmsView's n/a/g/⌫ → `/realms add <path>` …): a submit would error on
// missing args and a printed how-to is a dead-end; a prefill starts the
// exact command with the operator's cursor ready for the argument.
let pendingPrefill: string | null = null

export function requestPromptPrefill(text: string): void {
  // Modal permission focus (block E): a prefill flips the composer active
  // and yanks the card off focus — refused like every other gesture.
  if (refuseGestureWhileModal('the prompt prefill')) return
  pendingPrefill = text
  notify()
}

/** Consume the pending prompt prefill (null when none). */
export function consumePromptPrefill(): string | null {
  const t = pendingPrefill
  pendingPrefill = null
  return t
}

export function subscribeHelmFocus(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Monotonic version — the useSyncExternalStore snapshot (state reads are
 *  separate, matching the presence-store pattern: fresh objects can never be
 *  the snapshot or the store loops on Object.is). */
export function getHelmVersion(): number {
  return version
}

/** Pane-scoped snapshots — each rail subscribes to ITS slice only (stable
 *  function refs for useSyncExternalStore, hence two named getters). */
export function getHelmLanesVersion(): number {
  return paneVersion.lanes
}

export function getHelmTelemetryVersion(): number {
  return paneVersion.telemetry
}

/** External nudge: a store the lanes rail folds (e.g. the TABULA journal)
 *  changed outside the rail's own interactions — repaint the lanes pane so
 *  the glance reflects it without waiting for the next focus/row event. */
export function bumpHelmLanesVersion(): void {
  notifyPane('lanes')
}

export function getHelmFocus(): HelmPane {
  return focus
}

// ---- rail-entry buffer (the STALE-PAINT / idle-parked-commits discipline,
// applied to a FOCUS TRANSITION instead of a component mount): ↵ on a rail
// row ACTIVATES it (drills a teammate / submits a slash command), so the
// keystroke burst that moved focus INTO a rail — a parked Tab repeat, a fast
// Tab-↵ roll — must never fire an action on whatever row the cursor happens
// to rest on. A module timestamp, NEVER a React state flag: the input layer
// reads it fresh at dispatch time (the useOpenEventGate.ts doctrine — this
// site keeps a short WALL-CLOCK window on purpose: Tab key-REPEAT arrives as
// distinct later events, so event identity alone can't distinguish a parked
// repeat from an intentional ↵). Arrows / esc / tab stay immediate — only
// the ACTION key is gated.
let railEnteredAt = 0

/** True once a rail has held focus at least the entry buffer — gates ↵.
 *  `>=` so ms=0 means "buffer disabled" even within the entry millisecond. */
export function helmRailPastEntryBuffer(ms = 150): boolean {
  return Date.now() - railEnteredAt >= ms
}

export function setHelmFocus(p: HelmPane): void {
  if (focus === p) return
  focus = p
  if (p !== 'prompt') railEnteredAt = Date.now()
  notifyFocus()
}

export function cycleHelmFocus(): HelmPane {
  focus = nextHelmPane(focus)
  if (focus !== 'prompt') railEnteredAt = Date.now()
  notifyFocus()
  return focus
}

function clamp(pane: RailPane, i: number): number {
  const n = rows[pane].length
  return n === 0 ? 0 : Math.max(0, Math.min(n - 1, i))
}

export function getHelmCursor(pane: RailPane): number {
  return cursor[pane]
}

function stampCursorSig(pane: RailPane): void {
  const row = rows[pane][cursor[pane]]
  cursorSig[pane] = row ? helmRowSig(row) : ''
}

export function moveHelmCursor(pane: RailPane, delta: number): void {
  const next = clamp(pane, cursor[pane] + delta)
  if (next === cursor[pane]) return
  cursor[pane] = next
  stampCursorSig(pane)
  notifyPane(pane)
}

/** Pointer parity (interaction-finish slice 3): a click on an UNSELECTED
 *  rail row moves the keyboard cursor there (and focuses the pane), so the
 *  pointer and the ↑↓ model can never disagree about which row is current.
 *  The activate step stays requestHelmRowActivation — same meaning as ↵. */
export function setHelmCursor(pane: RailPane, index: number): void {
  const next = clamp(pane, index)
  const focusChanged = focus !== pane
  if (focusChanged) {
    focus = pane
    railEnteredAt = Date.now()
  }
  if (next !== cursor[pane]) {
    cursor[pane] = next
    stampCursorSig(pane)
    notifyPane(pane)
  }
  if (focusChanged) notifyFocus()
}

export function currentHelmRow(pane: RailPane): HelmRow | undefined {
  return rows[pane][clamp(pane, cursor[pane])]
}

/** Rails publish their selectable rows each render. Signature-compared so an
 *  unchanged model is a no-op (no publish→notify→re-render loop). The census
 *  S4: the cursor RE-ANCHORS to the row it was resting on (by helmRowSig) —
 *  rows inserted/removed above it can never retarget the selection; the
 *  positional clamp survives only for a VANISHED row (nearest-position
 *  fallback, then the fallback row becomes the new anchor). The anchor
 *  records USER intent only (moveHelmCursor/setHelmCursor stamp it, plus
 *  the vanished-row fallback above) — an untouched rail stays at the top
 *  as rows insert, instead of drifting down with whatever row the first
 *  publish happened to place at index 0 (verify-wave F5). */
export function publishHelmRows(pane: RailPane, next: HelmRow[]): void {
  const sig = next.map(helmRowSig).join('|')
  if (sig === rowsSig[pane]) return
  const anchor = cursorSig[pane]
  rows[pane] = next
  rowsSig[pane] = sig
  if (anchor) {
    const anchored = next.findIndex(r => helmRowSig(r) === anchor)
    cursor[pane] = anchored >= 0 ? anchored : clamp(pane, cursor[pane])
    stampCursorSig(pane) // vanished-row fallback becomes the new rest point
  } else {
    cursor[pane] = clamp(pane, cursor[pane])
  }
  notifyPane(pane)
}

export function getHelmRows(pane: RailPane): HelmRow[] {
  return rows[pane]
}

/** Test-only reset (proofs run sequences against the module singleton). */
export function resetHelmFocusForTest(): void {
  focus = 'prompt'
  cursor.lanes = 0
  cursor.telemetry = 0
  cursorSig.lanes = ''
  cursorSig.telemetry = ''
  rows.lanes = []
  rows.telemetry = []
  rowsSig.lanes = ''
  rowsSig.telemetry = ''
  pendingActivation = null
  pendingCommand = null
  pendingPrefill = null
  telemetryAvailable = true
  promptEmpty = true
  railEnteredAt = 0
  version = 0
  paneVersion.lanes = 0
  paneVersion.telemetry = 0
}
