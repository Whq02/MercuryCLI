// ============================================================================
//  render-engine/flag.ts — the engine's ONE gate read.
//
//  MERCURY_RENDER_ENGINE is opt-in and default OFF: while it is off, no
//  product surface constructs the engine and the classic painter runs
//  byte-identically. The migration lane consults this gate at its mount
//  seam; the engine module itself never reads it twice.
// ============================================================================

import { flagEnabled } from '../substrate/flagRegistry.js'

/** LIVE read of the engine gate (the registry's opt-in polarity). */
export function renderEngineEnabled(): boolean {
  return flagEnabled('MERCURY_RENDER_ENGINE')
}
