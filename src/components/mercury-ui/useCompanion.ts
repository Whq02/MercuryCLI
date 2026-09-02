// ============================================================================
//  mercury-ui/useCompanion — ONE companion state machine for every surface.
//
//  The session companion (DEFAULT-ON since the boot-menu declutter — the
//  MERCURY_DECK_COMPANION env pin and the /companion toggle are the
//  off-switches): identity (the session accent creature), mood (the 8-mood
//  buddyState deriver over REPL-published companionSignals + the
//  content-derived failed verdict), pose (toCritterState), tone (buddyTone →
//  theme token), and SPEECH (the voice law's moment lines and tips over the
//  approved words — companionVoice · companionWords — with a fade tail).
//
//  Shared by: the deck-strip row (DeckCompanion), the hero speech bubble
//  beside the big art, and the narrow-REPL mini critter — so the creature can
//  never disagree with itself across surfaces. Cheap by construction: a
//  surface re-renders on the engine's snapshot changes and exactly once
//  more at a live line's fade instant — no per-second tick, no idle tick.
// ============================================================================

import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  buddyTone,
  type BuddyState,
  type BuddyToneKey,
} from '../../utils/cockpit/buddyState.js'
import {
  companionEngineSnapshot,
  companionEngineVersion,
  setCompanionSpeechBudget,
  subscribeCompanionEngine,
  QUIP_FADE_MS,
  QUIP_MS,
  SETTLE_MS,
  type SpeechKind,
} from '../../utils/cockpit/companionEngine.js'
import type { CritterState } from '../../utils/cockpit/critterData.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../mercuryPalette.js'
import { useSessionAccent, type Critter } from './sessionAccent.js'

export { QUIP_FADE_MS, QUIP_MS, SETTLE_MS }

/*
   The companion gate + the /companion TOGGLE (the operator's word:
   "there is no boot menu [on my launch path] — it should be a toggle";
   default-ON since the declutter). Explicit env wins ('1' on /
   '0' off — captures speak env), else the PERSISTED /companion toggle
   (global config, the /critter-pick pattern), else ON. The epoch store
   repaints every consumer the instant the toggle flips — no relaunch.
---------------------------------------------------------------------------- */

let companionEpoch = 0
const companionListeners = new Set<() => void>()
// The session-latest flip (set by /companion). Wins over the persisted
// config (it IS the operator's most recent intent) but never over an
// explicit env pin. Survives a read-only config home.
let sessionFlip: boolean | null = null

export function isDeckCompanionEnabled(): boolean {
  const env = flagEnv('MERCURY_DECK_COMPANION')
  if (env === '1') return true
  if (env === '0') return false
  if (sessionFlip !== null) return sessionFlip
  try {
    return getGlobalConfig().companionEnabled !== false
  } catch {
    return true
  }
}

/** Flip + persist the companion (the /companion command). Returns the new
 *  state. An explicit env pin still wins at read time — honest precedence. */
export function setCompanionEnabled(on: boolean): boolean {
  sessionFlip = on
  try {
    saveGlobalConfig(cfg => ({ ...cfg, companionEnabled: on }))
  } catch {
    // read-only config home — the session flip above still applies; the
    // choice just won't survive a relaunch.
  }
  companionEpoch += 1
  for (const cb of companionListeners) cb()
  return on
}

export function getCompanionEpoch(): number {
  return companionEpoch
}

export function subscribeCompanionEnabled(cb: () => void): () => void {
  companionListeners.add(cb)
  return () => {
    companionListeners.delete(cb)
  }
}

/** Subscription hook for mount-guard sites (DeckPane, MercuryHero): re-renders
 *  the caller when /companion flips, returns the live gate. */
export function useCompanionEnabled(): boolean {
  useSyncExternalStore(subscribeCompanionEnabled, getCompanionEpoch, getCompanionEpoch)
  return isDeckCompanionEnabled()
}

/** buddyTone token key → the actual mercuryPalette token (zero new hex; TERRA
 *  resolves to the LIVE session accent so a /critter re-tint follows). */
export function companionToneColor(key: BuddyToneKey, accent: string): string {
  switch (key) {
    case 'TERRA':
      return accent
    case 'IVORY':
      return IVORY
    case 'TEAL':
      return TEAL
    case 'AMBER':
      return AMBER
    case 'CRIMSON':
      return CRIMSON
    case 'SECOND':
      return SECOND
    case 'FAINT':
    default:
      return FAINT
  }
}

/**
 * A speaking surface's budget for a line (cells), reported to the engine for
 * as long as the surface is mounted and re-reported when the terminal size
 * moves it. The engine speaks only lines that fit the narrowest reporter.
 */
export function useCompanionSpeechBudget(cells: number): void {
  const id = useId()
  useEffect(() => {
    setCompanionSpeechBudget(id, cells)
    return () => setCompanionSpeechBudget(id, null)
  }, [id, cells])
}

export interface CompanionState {
  critter: Critter
  mood: BuddyState
  pose: CritterState
  /** The mood tone, resolved to a paintable token (accent-aware). */
  tone: string
  /** Live speech, or null when silent. `fading` = past the fade threshold;
   *  `kind` says whether it is a moment line or a tip. */
  quip: { text: string; fading: boolean; kind: SpeechKind } | null
}

/**
 * The live companion state — a pure SELECTOR over the singleton
 * companionEngine: every mounted surface observes
 * the same snapshot object/version, one event produces one transition and
 * at most one line, and mount order can never change what the creature
 * says. Call ONLY from components mounted behind isDeckCompanionEnabled()
 * — the engine arms its subscriptions/timers with the FIRST subscriber and
 * tears them down with the last, so an opted-out session runs none of this.
 */
export function useCompanion(): CompanionState {
  const critter = useSessionAccent()
  useSyncExternalStore(subscribeCompanionEngine, companionEngineVersion, companionEngineVersion)
  const snap = companionEngineSnapshot()
  // A live line re-renders exactly ONCE more, at its fade instant — never on
  // a per-second tick (a tick per second on every companion mount is a write
  // budget the render-cadence provers count, and the boot tip made it a
  // per-session cost). Expiry is the engine's own snapshot change; a silent
  // surface has no timer at all.
  const fadeAt = snap.quip ? snap.quip.at + snap.quip.ttl - (QUIP_MS - QUIP_FADE_MS) : 0
  const [, bumpFade] = useState(0)
  useEffect(() => {
    if (!snap.quip) return
    const wait = fadeAt - Date.now()
    if (wait <= 0) return
    const timer = setTimeout(() => bumpFade(t => t + 1), wait + 20)
    return () => clearTimeout(timer)
  }, [snap.quip, fadeAt])
  const tone = companionToneColor(buddyTone(snap.mood), critter.accent)

  return {
    critter,
    mood: snap.mood,
    pose: snap.pose,
    tone,
    quip: snap.quip ? { text: snap.quip.text, fading: Date.now() >= fadeAt, kind: snap.quip.kind } : null,
  }
}
