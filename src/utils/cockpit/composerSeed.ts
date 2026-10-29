
import type { Key } from '../../ink.js'
import * as pendingInput from '../../input-core/pending-input.js'
import { permissionCardMounted } from '../permissions/permissionFocus.js'
import { createSignal } from '../signal.js'

let armed = 0
let seeder: ((seed: string) => void) | null = null
let trimmer: (() => void) | null = null
let declineRow: number | null = null
let declineReporter: object | null = null
const consentRowsChanged = createSignal()

export function enterHeldByQueuedWords(): boolean {
  return permissionCardMounted() && pendingInput.text().trim() !== ''
}

export function reportConsentDeclineRow(token: object, row: number | null): () => void {
  declineReporter = token
  declineRow = row
  consentRowsChanged.emit()
  return () => {
    if (declineReporter !== token) return
    declineReporter = null
    declineRow = null
    consentRowsChanged.emit()
  }
}

export const subscribeConsentRows = consentRowsChanged.subscribe

export function consentDeclineRow(): number | null {
  return declineRow
}

export function queuedWordsHint(row: number | null): string {
  return row === null ? '↵ is off while words wait · ⌫ edits' : `↵ is off while words wait — 1 approves · ${row} declines · ⌫ edits`
}

export function registerComposerSeeder(fn: (seed: string) => void): () => void {
  seeder = fn
  return () => {
    if (seeder === fn) seeder = null
  }
}

export function registerComposerSeedTrimmer(fn: () => void): () => void {
  trimmer = fn
  return () => {
    if (trimmer === fn) trimmer = null
  }
}

export function armComposerSeed(): () => void {
  armed++
  let released = false
  return () => {
    if (released) return
    released = true
    armed = Math.max(0, armed - 1)
  }
}

export function isSeedableInput(input: string, key: Key): boolean {
  if (!input || input.trim().length === 0) return false
  if (key.ctrl || key.meta || key.super || key.escape || key.return || key.tab) return false
  if (key.backspace || key.delete) return false
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return false
  if (key.pageUp || key.pageDown || key.home || key.end) return false
  if (key.wheelUp || key.wheelDown) return false
  if (/^[0-9]+$/.test(input)) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(input)) return false
  return true
}

export function seedComposerDirect(text: string): boolean {
  if (!seeder || !text) return false
  seeder(text)
  return true
}

export function trySeedComposer(input: string, key: Key): boolean {
  if (armed <= 0 || !seeder) return false
  if ((key.backspace || key.delete) && !key.ctrl && !key.meta && trimmer) {
    trimmer()
    return true
  }
  if (!isSeedableInput(input, key)) return false
  seeder(input)
  return true
}

export function __composerSeedResetForTest(): void {
  armed = 0
  seeder = null
  trimmer = null
  declineRow = null
  declineReporter = null
}
