// ============================================================================
//  atlas — the effective binding table, derived.
//
//  `/keys` shows the operator what their keyboard actually does RIGHT NOW.
//  That has to be a QUERY over the live resolution inputs, never a printed
//  copy of the compiled defaults: the moment a panel prints its own table, a
//  user rebind, a project layer or a shadowed chord makes it a lie.
//
//  So everything here reads the same two sources the runtime reads — the
//  merged `ParsedBinding[]` the resolver resolves against, and the Action
//  Graph's authored meaning — and the reverse lookup runs the operator's
//  keystroke through `matchingBindings()`, the resolver's own matcher. No
//  parallel table, no second precedence rule.
//
//  Pure and React-free: the panel renders these shapes, and
//  scripts/cockpit-interaction/prove-input-atlas.ts drives them headlessly.
// ============================================================================

import { ACTION_GRAPH, type ActionMeta } from './actionGraph.js'
import { chordToDisplayString, chordToString } from './parser.js'
import { classifyChordDelivery, legacyByteClass, type ChordDelivery } from './delivery.js'
import { extendedKeysSupportedNow } from '../ink/session/capabilities.js'
import { matchingBindings } from './resolver.js'
import { getPlatform } from '../utils/platform.js'
import {
  getReservedShortcuts,
  normalizeKeyForComparison,
  type ReservedShortcut,
} from './reservedShortcuts.js'
import type { Key } from '../ink.js'
import type {
  KeybindingContextName,
  ParsedBinding,
  ParsedKeystroke,
} from './types.js'

/** What the effective table says about one action.
 *  · bound     — a chord fires it;
 *  · disabled  — the chord that would fire it resolves to null (the action is
 *                masked; a printable keystroke types instead — HZ2);
 *  · unbound   — no chord reaches it at all (`reason` says why). */
export type AtlasState = 'bound' | 'disabled' | 'unbound'

/** Which layer wrote the winning entry. */
export type AtlasOrigin = 'default' | 'user'

export type AtlasShadow = {
  action: string | null
  context: KeybindingContextName
  origin: AtlasOrigin
}

export type AtlasRow = {
  /** Action id, `command:<name>`, or `null` for a pure unbind entry. */
  action: string | null
  /** Authored meaning from the Action Graph; a sentence for command bindings. */
  description: string
  context: KeybindingContextName
  /** Canonical chord text, `''` on an `unbound` row. */
  chord: string
  origin: AtlasOrigin
  state: AtlasState
  /** Entries this row's chord beat, earliest first (resolver order). */
  shadowed: readonly AtlasShadow[]
  /** Set when the chord is one the terminal or OS usually keeps. */
  reserved?: ReservedShortcut
  /** Set on `unbound` rows: the authored rebind-only reason, or the fact that
   *  the operator's own configuration removed the default. */
  reason?: string
  /** 3.6.3b: whether THIS terminal can put the chord on
   *  the wire distinctly — the delivery classification under the live
   *  keyboard-protocol fact. Absent on unbound rows (no chord). */
  delivery?: ChordDelivery
  /** Set when the chord's bytes COLLAPSE onto another bound chord in the
   *  SAME context with a DIFFERENT action — the class where a collapsed
   *  Ctrl+Shift+O would silently invoke Ctrl+O's action. The panel and
   *  binding validation surface this; it is never silent. */
  collidesWith?: { chord: string; action: string | null }
}

/** The meaning of an action id for display. `command:` bindings describe
 *  themselves; an id outside the graph is reported as such rather than
 *  silently blanked (that is drift, and the atlas exists to show it). */
export function describeAction(action: string | null): string {
  if (action === null) return 'disabled — the keystroke is not claimed'
  if (action.startsWith('command:')) return `Run /${action.slice('command:'.length)}`
  const meta = (ACTION_GRAPH as Record<string, { description: string }>)[action]
  return meta ? meta.description : `${action} — not in the Action Graph`
}

function reservedFor(
  chord: string,
  reserved: readonly ReservedShortcut[],
): ReservedShortcut | undefined {
  const norm = normalizeKeyForComparison(chord)
  return reserved.find(r => normalizeKeyForComparison(r.key) === norm)
}

export type BuildAtlasOptions = {
  /** How many leading entries of `bindings` came from DEFAULT_BINDINGS. The
   *  loader assembles defaults-then-user-then-project and the resolver takes
   *  the LAST match, so the index IS the layer. */
  defaultCount: number
  /** Defaults to the current platform's set. */
  reserved?: readonly ReservedShortcut[]
  /** Chords render in the operator's own dialect (opt on macOS, alt
   *  elsewhere). The spelling round-trips: parseKeystroke accepts every
   *  modifier alias, so a chord written back from this panel parses to the
   *  same keystroke it displays. */
  platform?: DisplayPlatform
  /** The keyboard-protocol fact the delivery column classifies under.
   *  Defaults to the live latch (identity-sniffed, upgraded by the boot
   *  kitty probe) — injectable so proofs pin both protocol worlds (UI-123:
   *  one injected snapshot, no ambient fallthrough). */
  extendedKeys?: boolean
}

/** The dialects chordToDisplayString distinguishes. */
export type DisplayPlatform = 'macos' | 'windows' | 'linux' | 'wsl' | 'unknown'

/**
 * The effective table: one row per (context, chord) that resolution can reach,
 * plus one row for every graph action nothing reaches.
 *
 * Rows sort by context then action so the panel scans; the resolver's own
 * last-wins order is preserved inside `shadowed`.
 */
export function buildAtlas(
  bindings: readonly ParsedBinding[],
  {
    defaultCount,
    reserved = getReservedShortcuts(),
    platform = getPlatform() as DisplayPlatform,
    extendedKeys = extendedKeysSupportedNow(),
  }: BuildAtlasOptions,
): AtlasRow[] {
  type Entry = { index: number; binding: ParsedBinding; chord: string; canonical: string }
  const groups = new Map<string, Entry[]>()
  bindings.forEach((binding, index) => {
    const chord = chordToDisplayString(binding.chord, platform)
    const canonical = chordToString(binding.chord)
    const key = `${binding.context}\u0000${chord}`
    const bucket = groups.get(key)
    if (bucket) bucket.push({ index, binding, chord, canonical })
    else groups.set(key, [{ index, binding, chord, canonical }])
  })

  const originOf = (index: number): AtlasOrigin =>
    index >= defaultCount ? 'user' : 'default'

  const rows: AtlasRow[] = []
  const reachable = new Set<string>()
  // 3.6.3b: per-context byte-class index for the collision column — a bound
  // chord whose bytes collapse onto ANOTHER bound chord in the same context.
  const byteClassIndex = new Map<string, Array<{ chord: string; action: string | null }>>()
  for (const entries of groups.values()) {
    const winner = entries[entries.length - 1]
    if (!winner) continue
    const action = winner.binding.action
    if (action !== null) reachable.add(action)
    const delivery = classifyChordDelivery(winner.canonical, extendedKeys)
    rows.push({
      action,
      description: describeAction(action),
      context: winner.binding.context,
      chord: winner.chord,
      origin: originOf(winner.index),
      state: action === null ? 'disabled' : 'bound',
      shadowed: entries.slice(0, -1).map(e => ({
        action: e.binding.action,
        context: e.binding.context,
        origin: originOf(e.index),
      })),
      reserved: reservedFor(winner.chord, reserved),
      delivery,
    })
    if (action !== null && winner.canonical.split(/\s+/).length === 1) {
      const cls = legacyByteClass(winner.canonical)
      if (cls) {
        const key = `${winner.binding.context} ${cls}`
        const list = byteClassIndex.get(key) ?? []
        list.push({ chord: winner.chord, action })
        byteClassIndex.set(key, list)
      }
    }
  }
  // UI-063/064: annotate same-context collapses — never silent. Only the
  // ALIASING side (the chord the legacy wire cannot deliver distinctly)
  // carries the marker; on an extended-keys terminal nothing collapses.
  if (!extendedKeys) {
    for (const list of byteClassIndex.values()) {
      if (list.length < 2) continue
      if (new Set(list.map(e => e.action)).size < 2) continue
      for (const entry of list) {
        const row = rows.find(r => r.chord === entry.chord && r.action === entry.action)
        if (!row || row.delivery?.status !== 'aliases-to') continue
        const sibling = list.find(e => e !== entry)
        if (sibling) row.collidesWith = { chord: sibling.chord, action: sibling.action }
      }
    }
  }

  // Every authored action nothing reaches — the honest half of the table.
  // Two distinct reasons, and the difference matters to the operator: an
  // action that SHIPS without a default carries its authored justification;
  // an action whose default the operator's own file removed says so.
  const graph = ACTION_GRAPH as Record<string, ActionMeta>
  for (const [action, meta] of Object.entries(graph)) {
    if (reachable.has(action)) continue
    const removedBy = rows.find(
      r => r.state === 'disabled' && r.shadowed.some(s => s.action === action),
    )
    rows.push({
      action,
      description: meta.description,
      context: removedBy?.context ?? meta.contexts[0] ?? 'Global',
      chord: '',
      origin: removedBy ? 'user' : 'default',
      state: 'unbound',
      shadowed: [],
      reason: removedBy
        ? `your configuration unbinds ${removedBy.chord} in ${removedBy.context}`
        : (meta.rebindOnly ?? 'ships without a default binding'),
    })
  }

  rows.sort(
    (a, b) =>
      a.context.localeCompare(b.context) ||
      String(a.action).localeCompare(String(b.action)) ||
      a.chord.localeCompare(b.chord),
  )
  return rows
}

/**
 * The palette's ranking shape, applied to the atlas: fuzzy (subsequence) on
 * the action ID, substring on everything else.
 *
 * Fuzzing the whole row was the first cut and it was useless — "stash" is a
 * subsequence of half the descriptions in the graph, so the filter returned
 * ten rows that had nothing to do with stashing. The id is the unambiguous
 * handle; prose gets the stricter test.
 */
export function atlasMatches(row: AtlasRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const id = String(row.action ?? '').toLowerCase()
  let qi = 0
  for (let i = 0; i < id.length && qi < q.length; i++) {
    if (id[i] === q[qi]) qi++
  }
  if (qi === q.length) return true
  return `${row.description} ${row.context} ${row.chord}`.toLowerCase().includes(q)
}

// ── one action's live affordance ────────────────────────────────────────────

/** What a surface may honestly say about one action, right now.
 *  · bound    — show this chord;
 *  · disabled — a later entry unbound the chord that reached it;
 *  · unbound  — nothing reaches it, and `reason` says why. */
export type ActionAffordance =
  | { kind: 'bound'; chord: string }
  | { kind: 'disabled'; chord: string; reason: string }
  | { kind: 'unbound'; reason: string }

/**
 * The single question every hint, badge and help row actually asks: *can the
 * operator reach this action, and with what?*
 *
 * Resolved from the live bindings, including the shadow check a naive
 * "find my action" lookup misses — a user entry that null-unbinds the chord
 * leaves the ACTION's own entry sitting earlier in the list, so searching for
 * the action still finds a chord that no longer fires it. Surfaces that skip
 * this advertise a dead key.
 */
export function actionAffordance(
  action: string,
  context: KeybindingContextName,
  bindings: readonly ParsedBinding[],
  platform: DisplayPlatform = getPlatform() as DisplayPlatform,
): ActionAffordance {
  const own = bindings.findLast(b => b.action === action && b.context === context)
  if (!own) {
    const meta = (ACTION_GRAPH as Record<string, ActionMeta>)[action]
    return {
      kind: 'unbound',
      reason: meta?.rebindOnly ?? 'no binding in this context',
    }
  }
  const chord = chordToDisplayString(own.chord, platform)
  const winner = bindings.findLast(
    b => b.context === context && chordToDisplayString(b.chord, platform) === chord,
  )
  if (winner && winner.action !== action) {
    return {
      kind: 'disabled',
      chord,
      reason:
        winner.action === null
          ? 'your configuration unbinds this chord'
          : `your configuration gives ${chord} to ${winner.action}`,
    }
  }
  return { kind: 'bound', chord }
}

// ── reverse lookup ──────────────────────────────────────────────────────────

export type LookupOutcome =
  | 'match'
  | 'unbound'
  | 'none'
  | 'chord_started'
  | 'chord_cancelled'

export type LookupReport = {
  outcome: LookupOutcome
  /** Canonical text of the full sequence tested (prefix included). */
  chord: string
  action?: string
  description?: string
  /** The context whose binding won. */
  context?: KeybindingContextName
  /** Every binding that matched, resolver order — the last one won. */
  candidates: readonly AtlasShadow[]
  reserved?: ReservedShortcut
  /** One plain sentence: what this keystroke does, right now, here. */
  verdict: string
}

export type ExplainOptions = {
  defaultCount: number
  reserved?: readonly ReservedShortcut[]
  platform?: DisplayPlatform
  /** Whether an unclaimed keystroke reaches the editor as text — the HZ2
   *  decision, passed in so the panel and the runtime cannot disagree. */
  passesThroughToEditor: boolean
}

/**
 * Turn one live resolution into the sentence the panel prints.
 *
 * `result` is what the runtime's `resolveKeyWithChordState` returned for this
 * exact keystroke; `matchingBindings` re-reads the same inputs to name what
 * the winner beat. Nothing is stored: this is a lookup, and the keystroke is
 * gone the moment the report is rendered.
 */
export function explainResolution(
  input: string,
  key: Key,
  contexts: readonly KeybindingContextName[],
  bindings: readonly ParsedBinding[],
  pending: ParsedKeystroke[] | null,
  result: { type: LookupOutcome; action?: string; pending?: ParsedKeystroke[] },
  {
    defaultCount,
    reserved = getReservedShortcuts(),
    platform = getPlatform() as DisplayPlatform,
    passesThroughToEditor,
  }: ExplainOptions,
): LookupReport {
  const matched = matchingBindings(
    input,
    key,
    [...contexts],
    bindings as ParsedBinding[],
    pending,
  )
  const candidates: AtlasShadow[] = matched.map(binding => ({
    action: binding.action,
    context: binding.context,
    origin: bindings.indexOf(binding) >= defaultCount ? 'user' : 'default',
  }))
  const winner = matched[matched.length - 1]
  const chord =
    result.type === 'chord_started' && result.pending
      ? chordToDisplayString(result.pending, platform)
      : winner
        ? chordToDisplayString(winner.chord, platform)
        : pending
          ? `${chordToDisplayString(pending, platform)} …`
          : describeKeystroke(input, key, platform)
  const reservedHit = reservedFor(chord, reserved)

  let verdict: string
  switch (result.type) {
    case 'match':
      verdict = `${result.action ?? ''} — ${describeAction(result.action ?? null)}`
      break
    case 'unbound':
      verdict = passesThroughToEditor
        ? 'disabled here — the keystroke types into the editor instead'
        : 'disabled here — the keystroke is masked and reaches nothing'
      break
    case 'chord_started':
      verdict = 'chord prefix — waiting for the next keystroke'
      break
    case 'chord_cancelled':
      verdict = 'chord cancelled — the prefix was dropped'
      break
    case 'none':
      verdict = passesThroughToEditor
        ? 'no binding here — the keystroke belongs to the editor'
        : 'no binding here'
      break
  }

  return {
    outcome: result.type,
    chord,
    action: result.action,
    description: result.action ? describeAction(result.action) : undefined,
    context: winner?.context,
    candidates,
    reserved: reservedHit,
    verdict,
  }
}

/** Best-effort canonical text for a raw keystroke that matched nothing. */
function describeKeystroke(
  input: string,
  key: Key,
  platform: DisplayPlatform = 'linux',
): string {
  const parts: string[] = []
  if (key.ctrl) parts.push('ctrl')
  if (key.meta) parts.push(platform === 'macos' ? 'opt' : 'alt')
  if (key.shift) parts.push('shift')
  if (key.super) parts.push(platform === 'macos' ? 'cmd' : 'super')
  const named =
    key.escape ? 'Esc'
    : key.return ? 'Enter'
    : key.tab ? 'tab'
    : key.backspace ? 'Backspace'
    : key.delete ? 'Delete'
    : key.upArrow ? '↑'
    : key.downArrow ? '↓'
    : key.leftArrow ? '←'
    : key.rightArrow ? '→'
    : key.pageUp ? 'PageUp'
    : key.pageDown ? 'PageDown'
    : key.home ? 'Home'
    : key.end ? 'End'
    : input === ' ' ? 'Space'
    : input
  parts.push(named)
  return parts.join('+')
}

// ── free-chord suggestions ──────────────────────────────────────────────────

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/**
 * Chords nothing claims in this context, in a fixed order — so the panel's
 * suggestion is the same on every machine and in every proof run.
 *
 * The pool is deliberately narrow: `alt+<letter>` (one keystroke, no terminal
 * collision on the supported hosts) then `ctrl+x <letter>` (Mercury's own
 * readline-style prefix suite). A candidate is free when neither this context
 * nor Global binds it and no reserved chord claims it.
 */
export function suggestFreeChords(
  bindings: readonly ParsedBinding[],
  context: KeybindingContextName,
  {
    limit = 5,
    reserved = getReservedShortcuts(),
  }: { limit?: number; reserved?: readonly ReservedShortcut[] } = {},
): string[] {
  const taken = new Set<string>()
  for (const binding of bindings) {
    if (binding.context !== context && binding.context !== 'Global') continue
    taken.add(normalizeKeyForComparison(chordToString(binding.chord)))
  }
  for (const r of reserved) taken.add(normalizeKeyForComparison(r.key))

  const out: string[] = []
  const pool: string[] = []
  for (const ch of LETTERS) pool.push(`alt+${ch}`)
  for (const ch of LETTERS) pool.push(`ctrl+x ${ch}`)
  for (const candidate of pool) {
    if (out.length >= limit) break
    if (taken.has(normalizeKeyForComparison(candidate))) continue
    out.push(candidate)
  }
  return out
}
