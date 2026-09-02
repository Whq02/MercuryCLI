import type { Command } from '../../commands.js'
import { isTabulaEnabled } from '../../utils/tabula/tabulaGates.js'

// ============================================================================
// commands/tabula — MINERVA'S ROOM (+ the /note journal and /minerva line).
// ----------------------------------------------------------------------------
// `/tabula` opens Minerva's room: you talk to
// Minerva there, and its one job is refining your SAVED PROMPTS (the prompts
// panel's third tab) — only when asked, always beside your wording, never
// sending anything. With no Minerva model pinned (/submodels) the room says
// so in one line and the saved prompts sit. The free-notes board the room
// replaces is gone from the surface; earlier notes stay readable in their
// plain notepad.md under the Mercury config home.
//
// `/note <text>` still appends to that per-project journal (zero model
// turns; the file on disk is its face now), and `/minerva <msg>` still turns
// a line into note ops on it — one billed call, consented by typing it.
// MINERVA (its model is the minerva sub-model container) organizes the
// journal once per boot when armed (boot-menu opt-in).
//
// MERCURY_TABULA gated: OFF ⇒ all three commands absent ⇒ byte-identical.
// Interactive-only (an operator surface, not a headless flow).
// ============================================================================

export const tabulaCommand = {
  type: 'local-jsx',
  name: 'tabula',
  description: "Minerva's room — talk to Minerva; it refines your saved prompts when you ask (model: /submodels)",
  isEnabled: () => isTabulaEnabled(),
  isHidden: false,
  load: () => import('./tabula.js'),
} satisfies Command

export const noteCommand = {
  type: 'local',
  name: 'note',
  description: 'Capture a note into the project notepad file (kept on disk under the Mercury config home)',
  argumentHint: '<a note to keep, or something to do later>',
  isEnabled: () => isTabulaEnabled(),
  isHidden: false,
  supportsNonInteractive: false,
  // The note is the operator's own journal line — the command-privacy law:
  // it executes at the screen, lands in the SCREEN project's notepad (the
  // estate Minerva's room reads), never enters a model conversation, never
  // starts a turn, on any seat.
  userPrivate: true,
  load: () => import('./note.js'),
} satisfies Command

export const minervaCommand = {
  type: 'local',
  name: 'minerva',
  description: 'Message the notepad curator — one billed Minerva call turns your words into notes in the notepad file (model: /submodels)',
  argumentHint: '<tell Minerva what to capture, close, or re-prioritize>',
  isEnabled: () => isTabulaEnabled(),
  isHidden: false,
  supportsNonInteractive: false,
  // One billed MINERVA call by contract — the SESSION's model is never
  // woken and the exchange stays the operator's own (privacy law).
  userPrivate: true,
  load: () => import('./minerva.js'),
} satisfies Command

export default tabulaCommand
