
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


let companionEpoch = 0
const companionListeners = new Set<() => void>()
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

export function setCompanionEnabled(on: boolean): boolean {
  sessionFlip = on
  try {
    saveGlobalConfig(cfg => ({ ...cfg, companionEnabled: on }))
  } catch {
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

export function useCompanionEnabled(): boolean {
  useSyncExternalStore(subscribeCompanionEnabled, getCompanionEpoch, getCompanionEpoch)
  return isDeckCompanionEnabled()
}

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
  tone: string
  quip: { text: string; fading: boolean; kind: SpeechKind } | null
}

export function useCompanion(): CompanionState {
  const critter = useSessionAccent()
  useSyncExternalStore(subscribeCompanionEngine, companionEngineVersion, companionEngineVersion)
  const snap = companionEngineSnapshot()
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
