
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

export type AtlasState = 'bound' | 'disabled' | 'unbound'

export type AtlasOrigin = 'default' | 'user'

export type AtlasShadow = {
  action: string | null
  context: KeybindingContextName
  origin: AtlasOrigin
}

export type AtlasRow = {
  action: string | null
  description: string
  context: KeybindingContextName
  chord: string
  origin: AtlasOrigin
  state: AtlasState
  shadowed: readonly AtlasShadow[]
  reserved?: ReservedShortcut
  reason?: string
  delivery?: ChordDelivery
  collidesWith?: { chord: string; action: string | null }
}

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
  defaultCount: number
  reserved?: readonly ReservedShortcut[]
  platform?: DisplayPlatform
  extendedKeys?: boolean
}

export type DisplayPlatform = 'macos' | 'windows' | 'linux' | 'wsl' | 'unknown'

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


export type ActionAffordance =
  | { kind: 'bound'; chord: string }
  | { kind: 'disabled'; chord: string; reason: string }
  | { kind: 'unbound'; reason: string }

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


export type LookupOutcome =
  | 'match'
  | 'unbound'
  | 'none'
  | 'chord_started'
  | 'chord_cancelled'

export type LookupReport = {
  outcome: LookupOutcome
  chord: string
  action?: string
  description?: string
  context?: KeybindingContextName
  candidates: readonly AtlasShadow[]
  reserved?: ReservedShortcut
  verdict: string
}

export type ExplainOptions = {
  defaultCount: number
  reserved?: readonly ReservedShortcut[]
  platform?: DisplayPlatform
  passesThroughToEditor: boolean
}

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


const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

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
