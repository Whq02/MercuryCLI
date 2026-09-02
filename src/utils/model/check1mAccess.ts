/**
 * Per-family 1M-context access checks.
 *
 * The 1M window is a catalogue fact owned by utils/model/capabilities: a
 * family offers it unless the MERCURY_DISABLE_1M_CONTEXT kill switch is set.
 * The large and mid checks are two entry points with IDENTICAL bodies — kept
 * separate (callers name the family) but with no invented difference.
 */
import { is1mContextDisabled } from './capabilities.js'

function familyHas1mAccess(): boolean {
  return !is1mContextDisabled()
}

export function checkOpus1mAccess(): boolean {
  return familyHas1mAccess()
}

export function checkSonnet1mAccess(): boolean {
  return familyHas1mAccess()
}
