// ============================================================================
//  substrate/bootNotes — the boot-preamble contract's structured notes
// Before the first Ink
//  frame Mercury may print AT MOST one themed status line; everything else
//  becomes a NOTE here: the setup card's collapsed disclosure row shows
//  them on first-run, returning boots get the one summary line, and
//  /doctor carries the drill-down. Raw stderr above the UI is the leak
//  class this closes.
//
//  Two producers:
//    · in-process emitters (startupMenu boot-env refusals) call addBootNote;
//    · the LAUNCHER (a shell script — no process continuity) writes a
//      handshake file beside splash-action.json ($MERCURY_HOME/boot-notes
//      .json); collectLauncherNotes() ingests + clears it at boot.
// ============================================================================

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'

export interface BootNote {
  kind: 'info' | 'warn'
  text: string
  when: number
}

const notes: BootNote[] = []
const MAX_NOTES = 16

export function addBootNote(kind: BootNote['kind'], text: string): void {
  if (notes.length >= MAX_NOTES) return
  notes.push({ kind, text: text.slice(0, 200), when: Date.now() })
  logForDebugging(`[boot-note:${kind}] ${text}`)
}

export function bootNotes(): readonly BootNote[] {
  return notes
}

/** The launcher handshake file (shell-side producer, one boot's worth). */
export function launcherNotesPath(configHome: string = getMercuryHome()): string {
  return join(configHome, 'boot-notes.json')
}

/** Ingest + clear the launcher's notes (idempotent; malformed files are a
 *  debug line, never a boot failure). Call once early in main(). */
export function collectLauncherNotes(configHome: string = getMercuryHome()): void {
  const path = launcherNotesPath(configHome)
  try {
    if (!existsSync(path)) return
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      notes?: { kind?: string; text?: string }[]
    }
    for (const n of raw.notes ?? []) {
      if (typeof n.text === 'string' && n.text.trim()) {
        addBootNote(n.kind === 'warn' ? 'warn' : 'info', n.text.trim())
      }
    }
  } catch (err) {
    logForDebugging(`[boot-note] launcher notes unreadable: ${String(err)}`)
  } finally {
    try {
      rmSync(path, { force: true })
    } catch {
      /* consumed best-effort */
    }
  }
}

/** TEST-ONLY: reset (proof harnesses). */
export function _resetBootNotesForTesting(): void {
  notes.length = 0
}
