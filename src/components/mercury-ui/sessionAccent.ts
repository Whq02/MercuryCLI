// ============================================================================
//  mercury-ui/sessionAccent — THE SCREEN's critter: the costume this
//  process wears, process-lifetime.
//
//  Under Law 9 a SESSION is the daemon-hosted unit and carries no critter;
//  the critter belongs to the SCREEN — this terminal's costume, chosen for
//  this process and worn by every view it paints (the boot face, the chat,
//  the concourse header), whichever session is focused. The module keeps
//  its historical name and exported spellings (getSessionAccent and kin —
//  85 importers); the words here say what the thing is.
//
//  The screen's critter tints ONLY the identity chrome (frame, wordmark,
//  sigil, panel borders, headers, prompt caret) — never the status spine.
//  TEAL/AMBER/CRIMSON keep their fixed meaning so on/warn/blocked read
//  identically in every theme (tokens/themes.css rule: "Identity changes;
//  semantics never do"). Selected at launch via MERCURY_CRITTER; the pool
//  default is critterData's DEFAULT_CRITTER_KEY (jellyfish since,
// an env pin, persisted /critter pick, or /accent override wins).
//  This is the Ink form of the design system's .theme-<critter> CSS scopes.
// ============================================================================

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
import { scribeModeEnabled } from '../../utils/scribe/scribeGates.js'
import { isScribeModeOn, subscribeScribeMode } from '../../utils/scribeMode.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

// ── Scribe Mode "Amanuensis" glow (Phase 7) ─────────────────────────────────
// When the foreground session IS the Scribe, its identity chrome (frame /
// wordmark / panel borders / prompt caret — the same surfaces a critter accent
// tints) glows a hotter, brighter, incandescent version of the ACTIVE critter's
// accent — so scribe mode FOLLOWS the critter theme (clam → glowing teal,
// octopus → glowing violet …) instead of a fixed red that ignored the critter.
// The crab keeps its hand-tuned SCRIBE_GLOW ember (byte-identical); every
// other critter gets a per-channel brightened version of its OWN accent (glowOf).
// The status spine (TEAL/AMBER/CRIMSON) is NOT touched — only the identity accent.
// Opt out with MERCURY_SCRIBE_GLOW=0 (then the accent is byte-identical to today).
export const SCRIBE_GLOW = '#FF5A3A'
/** A deeper ember for the accentDeep slot (claws / deep accent), still red. */
export const SCRIBE_GLOW_DEEP = '#D2401F'

/**
 * Brighten a hex accent into a luminous "glow" that PRESERVES the critter's hue:
 * per-channel multiply (×1.18) + clamp to 255 — raises brightness while keeping
 * saturation/hue, so a teal critter glows teal, a violet one violet. Deterministic,
 * no color lib. Falls through unchanged on a non-#rrggbb input.
 */
export function glowOf(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return hex
  const up = (h: string): string =>
    Math.min(255, Math.round(parseInt(h, 16) * 1.18))
      .toString(16)
      .padStart(2, '0')
  return `#${up(m[1]!)}${up(m[2]!)}${up(m[3]!)}`
}

/** True iff the Scribe glow should re-tint the identity accent right now.
 *  The engage bit is read FIRST: it is a module boolean, while the two flag
 *  reads walk the registry and the environment — a session with the Scribe
 *  disengaged (the common one) answers without either. Every subscriber's
 *  snapshot read passes through here. */
export function scribeGlowEnabled(): boolean {
  if (!isScribeModeOn()) return false
  if (flagEnv('MERCURY_SCRIBE_GLOW') === '0') return false
  return scribeModeEnabled()
}

/** The glowed variant per base critter, built once: the glow is a pure
 *  function of the base's accent pair, and a subscriber that reads the
 *  accent on every render sees the SAME object while nothing changed (the
 *  useSyncExternalStore-primitive law, kept for the object the hook returns). */
const GLOWED_BY_KEY = new Map<string, Critter>()

/** Overlay the glow onto a base critter when scribe mode is engaged; else identity. */
function applyScribeGlow(base: Critter): Critter {
  if (!scribeGlowEnabled()) return base
  const known = GLOWED_BY_KEY.get(base.key)
  if (known !== undefined) return known
  // Crab keeps its hand-tuned ember (the canonical scribe red); every other
  // critter glows a brightened version of its OWN accent so scribe FOLLOWS the
  // critter theme rather than overriding it with a fixed red.
  const glowed: Critter =
    base.key === 'crab'
      ? { ...base, accent: SCRIBE_GLOW, accentDeep: SCRIBE_GLOW_DEEP }
      : { ...base, accent: glowOf(base.accent), accentDeep: glowOf(base.accentDeep) }
  GLOWED_BY_KEY.set(base.key, glowed)
  return glowed
}

export type Critter = {
  key: string
  name: string
  accent: string // swaps TERRA (identity accent / frame / wordmark)
  accentDeep: string // swaps CLAW (crab claws / deep accent)
}

// The fixed non-crab hues are owned by
// critterData.ts (the React-free leaf, single source) and imported here so the
// theme schema and the splash/critter art can never desync on a retune; crab's
// accent is the live TERRA token.
export const CRITTERS: Record<string, Critter> = {
  crab: { key: 'crab', name: 'crab', accent: TERRA, accentDeep: CLAW },
  octopus: { key: 'octopus', name: 'octopus', accent: OCTOPUS_HUE, accentDeep: OCTOPUS_HUE_DEEP },
  jellyfish: { key: 'jellyfish', name: 'jellyfish', accent: JELLYFISH_HUE, accentDeep: JELLYFISH_HUE_DEEP },
  clam: { key: 'clam', name: 'clam', accent: CLAM_HUE, accentDeep: CLAM_HUE_DEEP },
  // (The off-rotation 'dragon' row was deleted with the
  //  rest of its estate. A saved or env-pinned 'dragon' now takes the bounded
  //  fallback in currentKey() below — the SAME pool default critterDefForKey
  //  resolves it to, so the shape and the tint can never disagree about which
  //  creature a retired key became. The retired mantis-shrimp spellings have
  //  a SUCCESSOR instead: LEGACY_CRITTER_KEYS resolves them to the clam in
  //  poolKeyOr below, read-side only — the stored value is never rewritten.)
}

export const ALL_CRITTERS: Critter[] = [
  CRITTERS.crab!,
  CRITTERS.octopus!,
  CRITTERS.jellyfish!,
  CRITTERS.clam!,
]

/** Per-principal accent for attributed transcript rows: a stable hash of
 *  the principal id into the EXISTING critter accent tokens — the same peer is
 *  always the same color, and no new hex enters the system. */
export function accentForPrincipal(principalId: string): string {
  let h = 0
  for (let i = 0; i < principalId.length; i++) {
    h = (h * 31 + principalId.charCodeAt(i)) >>> 0
  }
  return ALL_CRITTERS[h % ALL_CRITTERS.length]!.accent
}

// THE SCREEN's critter — the LIVE OBSERVABLE (process-lifetime state of this
// terminal, never a session's). A once-at-startup read of MERCURY_CRITTER
// would make a /critter pick take effect only on relaunch. So /critter morphs
// + recolors synchronously (the design intent), the active key lives in a
// tiny module-level store: getSessionAccent() reads it, the /critter picker
// writes it via setSessionCritter(), and useSessionAccent() subscribes so
// every identity surface re-renders the instant the key changes. No new hex,
// no new key — same CRITTERS table, just made live.
//
// Precedence: MERCURY_CRITTER env (an explicit per-launch override, e.g. a spawned
// child or `MERCURY_CRITTER=crab mercury`) wins; then the persisted /critter
// default (GlobalConfig.defaultCritter, stamp-only — saved via the picker's `s` key);
// then the pool default (jellyfish since — DEFAULT_CRITTER_KEY is
// the one source). The config read is stamp-gated (defaultCritter only exists on a fork) and
// fully guarded so a config-read failure can never crash accent resolution.
// LAZY lock-in (operator bug: "the splash says Octopus but the
// session loads crab"): this module initializes at IMPORT time, before main()
// calls enableConfigs() — so the getGlobalConfig() read here always threw
// "Config accessed before allowed", the guard ate it, and the persisted
// default was dead-on-boot from day one (the env-pin path masked it: env
// needs no latch). The key now resolves on FIRST READ and only LOCKS once a
// real source answered — an env pin locks immediately; the config read locks
// when the latch is open (the first render is after enableConfigs()); a
// pre-latch read serves the pool default WITHOUT locking, so the next read
// retries.
let activeKey: string | null = null

/** THE BOUNDED FALLBACK for a RETIRED or unknown key.
 *  Both remaining inputs can name a critter that does not exist — a
 *  GlobalConfig.defaultCritter saved back when 'dragon' was pickable, or a
 *  MERCURY_CRITTER inherited through the env by a child process launched from
 *  such a session. Normalising HERE, at the one place a key is adopted, means
 *  a stale name resolves to the pool default everywhere at once instead of
 *  half-resolving: without it the key locked as 'dragon', the tint fell back to
 *  crab and the SHAPE fell back to the pool default — one session wearing two
 *  different creatures. Never throws; never leaves a dead key latched. */
function poolKeyOr(key: string): string {
  if (Object.hasOwn(CRITTERS, key)) return key
  // Pool NAME spellings normalise to their short key — critterDefForKey
  // answers to the name, so the colour half must land on the same creature
  // instead of bouncing to the fallback (an env pin of the species' own
  // picker-visible name once silently themed octopus).
  for (const k of Object.keys(CRITTERS)) {
    if (CRITTERS[k]!.name === key) return k
  }
  // RETIRED spellings with a successor resolve to it ('mantis' / 'mantis
  // shrimp' → 'clam') — the same shared table critterDefForKey reads, so the
  // tint and the shape land on the same creature; the stored config value is
  // never rewritten (read-side resolution only).
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
    // The boot latch isn't open yet — serve the default WITHOUT locking.
    return DEFAULT_CRITTER_KEY
  }
}
const listeners = new Set<() => void>()

// ── Accent EPOCH — the theme-resolution repaint signal ──────────
// ThemedBox/ThemedText resolve theme KEYS ('promptBorder' → hex) at their own
// render time, and getTheme() folds getSessionAccent() live — but a component
// whose ancestors don't subscribe never re-renders on an accent change, so its
// RESOLVED color goes stale (operator bug: the prompt box kept the old critter
// hue until an unrelated repaint like ctrl+o). The resolvers subscribe to THIS
// integer via useSyncExternalStore (allocation-free snapshot); it bumps on
// every accent-affecting store change: /critter picks, /accent overrides, and
// scribe toggles (bridged below — getSessionAccent reads the glow live).
let accentEpoch = 0
function bumpAccentEpoch(): void {
  accentEpoch++
}
export function getAccentEpoch(): number {
  return accentEpoch
}
// Scribe engage/disengage re-tints the accent without touching this store —
// bridge its observable once at module init so the epoch (and every resolver
// subscribed to it) covers the glow too (a glow that
// relies on incidental re-renders goes stale: epoch subscribers like ThemedBox resolve
// keys at their own render and could stay stale until an unrelated repaint —
// the exact class the epoch exists to kill).
subscribeScribeMode(() => {
  bumpAccentEpoch()
  for (const l of listeners) l()
})

// ── Operator accent OVERRIDE (/accent — "colour the REPL", QoL program) ─────
// An EXPLICIT operator pick outranks every DERIVED tint (critter hue, scribe
// glow, fable recolor) — the explicit-beats-default rule (the auto-mode lesson:
// an operator's explicit choice is never silently displaced by a mode default).
// Process-lifetime (this screen's own, never persisted, never a session's);
// null = no override (the derivation chain below applies unchanged ⇒
// byte-identical when unused).
let accentOverride: Critter | null = null

/** Derive the deep companion (claws / deep borders) from one accent hex — the
 *  inverse of glowOf: same per-channel math, darkened toward the night canvas. */
export function deepOf(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return hex
  const down = (h: string): string =>
    Math.max(0, Math.round(parseInt(h, 16) * 0.56))
      .toString(16)
      .padStart(2, '0')
  return `#${down(m[1]!)}${down(m[2]!)}${down(m[3]!)}`
}

/**
 * Set (or clear, with null) the screen's accent override. Accepts #RGB/#RRGGBB
 * (with or without the #); returns false on junk input / a no-op clear, true
 * when the store changed (subscribers repaint synchronously, like /critter).
 */
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

/** The live override, or null when the default derivation chain applies. */
export function getSessionAccentOverride(): Critter | null {
  return accentOverride
}

/** The override-tinted critter, built once per (base, override) pair so the
 *  object the hook returns is the same across renders while neither moved. */
let overrideTint: { base: Critter; override: Critter; value: Critter } | null = null

// The screen's active critter. Reads the live store (seeded from MERCURY_CRITTER),
// so it reflects a /critter pick immediately and falls back to crab.
export function getSessionAccent(): Critter {
  const base = CRITTERS[currentKey()] ?? CRITTERS.crab!
  // Operator override is the FINAL word on the TINT AXES only (explicit beats
  // derived — /accent). The critter IDENTITY (key/name → the hero/logo art
  // shape via critterDefForKey) stays live, so /critter keeps cycling under an
  // override (operator bug: the old 'custom'-keyed return made every
  // art site fall back to the crab shape — critter switching looked dead).
  // Glow/fable recolor are skipped byte-equivalently: they only touch the two
  // accent axes the override replaces.
  if (accentOverride) {
    const memo = overrideTint
    if (memo !== null && memo.base === base && memo.override === accentOverride) return memo.value
    const value: Critter = { ...base, accent: accentOverride.accent, accentDeep: accentOverride.accentDeep }
    overrideTint = { base, override: accentOverride, value }
    return value
  }
  return applyScribeGlow(base)
}

// The raw active key (normalized), for shape lookups (critterDefForKey).
export function getSessionCritterKey(): string {
  return currentKey()
}

// Commit the screen's new critter live: re-tints identity chrome AND morphs the
// critter art on every subscribed surface, no relaunch. Unknown keys are ignored
// (the picker only ever passes ALL_CRITTERS keys). The env mirror is NOT for any
// in-process reader (activeKey above is authoritative — resolveInitialKey reads
// MERCURY_CRITTER only at module init); it is mirrored only so a CHILD PROCESS
// spawned AFTER this pick inherits the key via its cloned env.
export function setSessionCritter(key: string): void {
  const k = (key ?? '').trim().toLowerCase()
  if (!CRITTERS[k] || k === currentKey()) return
  activeKey = k
  try {
    setFlagEnv('MERCURY_CRITTER', k)
  } catch {
    /* env may be frozen; the in-memory store is the source of truth */
  }
  bumpAccentEpoch()
  for (const l of listeners) l()
}

/** The ONE click-to-cycle action every critter mount wires (hero, berth,
 *  mini — every size): advance to the next pool critter and make the pick
 *  STICK (live morph + persisted default), exactly like the /critter
 *  panel. One owner so a mount can never cycle without persisting or
 *  persist without morphing. */
export function cycleSessionCritter(): void {
  const i = ALL_CRITTERS.findIndex(c => c.key === currentKey())
  const next = ALL_CRITTERS[(i + 1) % ALL_CRITTERS.length]
  if (!next) return
  setSessionCritter(next.key)
  persistSessionCritter(next.key)
}

// there is no dedicated "poke" to recolor identity surfaces for an accent
// change that rides alongside the critter (the Scribe glow, applyScribeGlow). None is
// needed — engaging/disengaging Scribe Mode already re-renders the subscribed surfaces,
// so they re-read getSessionAccent()/applyScribeGlow and recolor on that incidental
// render (no key delta or manual listener notify). A prior pokeSessionAccent() export
// claimed scribeRouterSelect called it, but it had zero callers — removed as dead code.

// Persist the chosen critter as the cross-relaunch default (GlobalConfig.
// defaultCritter), so /critter outlives this screen. Flag-gated: a bare stamp never
// writes this key (byte-identical). Unknown keys are ignored. saveGlobalConfig is
// no-op-on-equal, so re-saving the same default is free.
export function persistSessionCritter(key: string): void {
  
  const k = (key ?? '').trim().toLowerCase()
  if (!CRITTERS[k]) return
  try {
    saveGlobalConfig(current => ({ ...current, defaultCritter: k }))
  } catch {
    /* a write failure leaves the live in-session pick intact; just not persisted */
  }
}

// useSyncExternalStore primitives — the testable observable contract. subscribe
// registers a re-render callback; the snapshot is a PRIMITIVE key (stable under
// React's identity check) that reflects EVERY store dimension a hook derives
// from: the active critter key AND the /accent override. The override half is
// load-bearing: with a key-only snapshot,
// setSessionAccentOverride()'s notify fired but useSyncExternalStore saw an
// unchanged snapshot and skipped the re-render — /accent changed what
// getSessionAccent() returned while every HOOK-subscribed surface (frame,
// wordmark, sigil, hero) kept the old color, and the command's confirmation
// line (function path) reported success the screen contradicted.
export function subscribeSessionCritter(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** The snapshot memo: the last snapshot and the three inputs it was built
 *  from. useSyncExternalStore reads the snapshot on every subscriber's render
 *  and on every notification and compares with Object.is — a string rebuilt
 *  per read costs a string per read and leaves every subscribing hook holding
 *  its own copy; built only when an input moves, every subscriber holds the
 *  one string. */
let snapshotMemo: { key: string; override: Critter | null; glow: string; value: string } | null = null
let snapshotBuilds = 0

/** The hook snapshot: changes on a /critter pick, an /accent set/clear, AND a
 *  scribe-glow flip (the glow changes what the derivation returns, so the
 *  snapshot must cover it or useSyncExternalStore skips the re-render). The
 *  same string object while none of the three moved. */
export function getSessionAccentSnapshotKey(): string {
  const key = currentKey()
  const glow = scribeGlowEnabled() ? 'glow' : ''
  const memo = snapshotMemo
  if (memo !== null && memo.key === key && memo.override === accentOverride && memo.glow === glow) return memo.value
  snapshotBuilds++
  const value = `${key}:${accentOverride ? accentOverride.accent : ''}:${glow}`
  snapshotMemo = { key, override: accentOverride, glow, value }
  return value
}

/** Proof seam: the live listener count and how many times the snapshot has
 *  been rebuilt (prove-accent-snapshot pins both). */
export function accentStoreStatsForProofs(): { listeners: number; snapshotBuilds: number } {
  return { listeners: listeners.size, snapshotBuilds }
}

// Subscribe a component to the screen's live critter. Re-renders on every
// setSessionCritter(), setSessionAccentOverride(), AND scribe flips — the
// live-morph plumbing. The /accent override is the FINAL word here exactly as
// in getSessionAccent() (explicit beats derived — critter hue, scribe glow,
// and fable recolor included).
//
// UNIFIED: a hook applying a DIFFERENT recolor rule
// than getSessionAccent() is the classic two-read-paths split (ledgered under
// one-surface-per-turn): the hero sprite hand-rolled one hue while
// hook-driven chrome kept the critter hue, so the home showed a mismatched
// sprite over the accents. Both paths now share ONE derivation:
// override → scribe glow. The /critter picker previews are unaffected (they
// read per-critter catalog colors, never this hook).
export function useSessionAccent(): Critter {
  useSyncExternalStore(
    subscribeSessionCritter,
    getSessionAccentSnapshotKey,
    getSessionAccentSnapshotKey,
  )
  // ONE derivation — delegate to getSessionAccent() (the split-home
  // lesson made literal): the subscription above provides the reactivity, the
  // plain reader owns the rule (override = tint axes only; shape stays live).
  return getSessionAccent()
}
