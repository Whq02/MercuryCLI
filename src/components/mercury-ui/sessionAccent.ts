
import { useSyncExternalStore } from 'react'
import { CLAW, TERRA } from '../mercuryPalette.js'
import { flagEnv, setFlagEnv } from '../../substrate/flagRegistry.js'
import {
  OCTOPUS_HUE,
  OCTOPUS_HUE_DEEP,
  JELLYFISH_HUE,
  JELLYFISH_HUE_DEEP,
  CLAM_HUE,
  CLAM_HUE_DEEP,
  DEFAULT_CRITTER_KEY,
  LEGACY_CRITTER_KEYS,
} from '../../utils/cockpit/critterData.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'


export type Critter = {
  key: string
  name: string
  accent: string
  accentDeep: string
}

export const CRITTERS: Record<string, Critter> = {
  crab: { key: 'crab', name: 'crab', accent: TERRA, accentDeep: CLAW },
  octopus: { key: 'octopus', name: 'octopus', accent: OCTOPUS_HUE, accentDeep: OCTOPUS_HUE_DEEP },
  jellyfish: { key: 'jellyfish', name: 'jellyfish', accent: JELLYFISH_HUE, accentDeep: JELLYFISH_HUE_DEEP },
  clam: { key: 'clam', name: 'clam', accent: CLAM_HUE, accentDeep: CLAM_HUE_DEEP },
}

export const ALL_CRITTERS: Critter[] = [
  CRITTERS.crab!,
  CRITTERS.octopus!,
  CRITTERS.jellyfish!,
  CRITTERS.clam!,
]

export function accentForPrincipal(principalId: string): string {
  let h = 0
  for (let i = 0; i < principalId.length; i++) {
    h = (h * 31 + principalId.charCodeAt(i)) >>> 0
  }
  return ALL_CRITTERS[h % ALL_CRITTERS.length]!.accent
}

let activeKey: string | null = null

function poolKeyOr(key: string): string {
  if (Object.hasOwn(CRITTERS, key)) return key
  for (const k of Object.keys(CRITTERS)) {
    if (CRITTERS[k]!.name === key) return k
  }
  const legacy = LEGACY_CRITTER_KEYS[key]
  if (legacy !== undefined && Object.hasOwn(CRITTERS, legacy)) return legacy
  return DEFAULT_CRITTER_KEY
}

function currentKey(): string {
  if (activeKey != null) return activeKey
  const env = flagEnv('MERCURY_CRITTER')
  if (env != null && env.trim() !== '') {
    activeKey = poolKeyOr(env.trim().toLowerCase())
    return activeKey
  }
  try {
    const saved = getGlobalConfig().defaultCritter
    activeKey =
      saved != null && saved.trim() !== ''
        ? poolKeyOr(saved.trim().toLowerCase())
        : DEFAULT_CRITTER_KEY
    return activeKey
  } catch {
    return DEFAULT_CRITTER_KEY
  }
}
const listeners = new Set<() => void>()

let accentEpoch = 0
function bumpAccentEpoch(): void {
  accentEpoch++
}
export function getAccentEpoch(): number {
  return accentEpoch
}
let accentOverride: Critter | null = null

export function deepOf(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return hex
  const down = (h: string): string =>
    Math.max(0, Math.round(parseInt(h, 16) * 0.56))
      .toString(16)
      .padStart(2, '0')
  return `#${down(m[1]!)}${down(m[2]!)}${down(m[3]!)}`
}

export function setSessionAccentOverride(hex: string | null): boolean {
  if (hex === null) {
    if (accentOverride === null) return false
    accentOverride = null
    bumpAccentEpoch()
    for (const l of listeners) l()
    return true
  }
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim())
  if (!m) return false
  let h = m[1]!.toLowerCase()
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const full = `#${h}`
  accentOverride = {
    key: 'custom',
    name: 'custom accent',
    accent: full,
    accentDeep: deepOf(full),
  }
  bumpAccentEpoch()
  for (const l of listeners) l()
  return true
}

export function getSessionAccentOverride(): Critter | null {
  return accentOverride
}

let overrideTint: { base: Critter; override: Critter; value: Critter } | null = null

export function getSessionAccent(): Critter {
  const base = CRITTERS[currentKey()] ?? CRITTERS.crab!
  if (accentOverride) {
    const memo = overrideTint
    if (memo !== null && memo.base === base && memo.override === accentOverride) return memo.value
    const value: Critter = { ...base, accent: accentOverride.accent, accentDeep: accentOverride.accentDeep }
    overrideTint = { base, override: accentOverride, value }
    return value
  }
  return base
}

export function getSessionCritterKey(): string {
  return currentKey()
}

export function setSessionCritter(key: string): void {
  const k = (key ?? '').trim().toLowerCase()
  if (!CRITTERS[k] || k === currentKey()) return
  activeKey = k
  try {
    setFlagEnv('MERCURY_CRITTER', k)
  } catch {
  }
  bumpAccentEpoch()
  for (const l of listeners) l()
}

export function cycleSessionCritter(): void {
  const i = ALL_CRITTERS.findIndex(c => c.key === currentKey())
  const next = ALL_CRITTERS[(i + 1) % ALL_CRITTERS.length]
  if (!next) return
  setSessionCritter(next.key)
  persistSessionCritter(next.key)
}

export function persistSessionCritter(key: string): void {
  
  const k = (key ?? '').trim().toLowerCase()
  if (!CRITTERS[k]) return
  try {
    saveGlobalConfig(current => ({ ...current, defaultCritter: k }))
  } catch {
  }
}

export function subscribeSessionCritter(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

let snapshotMemo: { key: string; override: Critter | null; value: string } | null = null
let snapshotBuilds = 0

export function getSessionAccentSnapshotKey(): string {
  const key = currentKey()
  const memo = snapshotMemo
  if (memo !== null && memo.key === key && memo.override === accentOverride) return memo.value
  snapshotBuilds++
  const value = `${key}:${accentOverride ? accentOverride.accent : ''}`
  snapshotMemo = { key, override: accentOverride, value }
  return value
}

export function accentStoreStatsForProofs(): { listeners: number; snapshotBuilds: number } {
  return { listeners: listeners.size, snapshotBuilds }
}

export function useSessionAccent(): Critter {
  useSyncExternalStore(
    subscribeSessionCritter,
    getSessionAccentSnapshotKey,
    getSessionAccentSnapshotKey,
  )
  return getSessionAccent()
}
