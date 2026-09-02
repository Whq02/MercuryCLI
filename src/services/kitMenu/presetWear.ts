// ============================================================================
//  services/kitMenu/presetWear — THE OPERATOR'S WEAR DOOR (ledger L24(4) +
//  the both-doors ruling): a saved preset worn by the
//  NEXT session — resolved screen-side over the LIVE roster, validated by
//  the wire's own narrowing, and armed as the ONE-SHOT presetKit on the
//  next-session facts (bootBirthFacts): the first door that spreads birth
//  facts consumes it — New Session, or a dead-transcript resume (the
//  operator armed it, then picked the session: that IS the intent); a LIVE
//  hop never consumes it (the daemon says `liveHop` — nothing re-stamped,
//  nothing spent) — and the sticky menu carry is untouched throughout, so
//  the menu's default resumes by construction.
//
//  THE HONEST RESOLVE (the store-home trade, carried here), AMENDED at P6
//  (the lead's one-law-at-both-doors ruling — the brief's blanket
//  doesn't-bite sentence predates DIALS' off-by-name schema): an OFF delta
//  naming a skill or an extension this repo lacks is KEPT OFF BY NAME —
//  carried into the worn kit's skillsOff / extensions map exactly as the
//  runner's completion carries it on the coordinator road
//  (kitCompletion.ts's off-carry), so a later-born member the preset said
//  off STAYS off whichever door wore the preset. An MCP delta naming a
//  server this repo lacks keeps the doesn't-bite law (a resolved kit's MCP
//  membership is a CLOSED list — absence already excludes later arrivals;
//  off-by-name does not exist for servers), and an INVOCABLE delta for an
//  absent skill does not carry at either door (the completion composes
//  invocable from the roster alone — the doors already agree). Everything
//  is NAMED on the receipt, never silently swallowed. Wearing NEVER
//  mutates the menu record, the preset store, or any live session: the
//  arm is a plain facts update.
//
//  Vocabulary law: "pack" is the extensions estate's word — these are
//  PRESETS, here and on every surface.
// ============================================================================
import { isKitExtensionName, isKitSkillName, validateSessionKit, type SessionKitV1 } from '../../daemon/sessionKit.js'
import { kitPresetDeltas, presetDeltaCount } from '../mcp/presetStore.js'
import { peekWornPresetKit, setNextSessionFacts } from '../switchboard/bootBirthFacts.js'
import type { KitDeltasShape } from './menuStore.js'
import { statesFromDeltas } from './menuStore.js'
import { resolvedKitOf } from './resolvedKit.js'
import { kitStateKey, type KitRow } from './kitTypes.js'

export type PresetWearResolution =
  | {
      ok: true
      kit: SessionKitV1
      /** Deltas that genuinely do not bite here (unmatched MCP names — the
       *  closed-membership law — and unmatched invocable states), in
       *  receipt words. */
      unmatched: string[]
      /** OFF deltas naming members this repo lacks, KEPT OFF BY NAME (the
       *  P6 off-carry: they bite any later-born member), in receipt words. */
      keptOff: string[]
    }
  | { ok: false; reason: string }

/** A delta key in plain receipt words ('postgres (MCP)', 'deploy (skill)',
 *  'orchard-tools (extension)'). */
function unmatchedWordOf(stateKey: string): string {
  if (stateKey.startsWith('mcp:')) return `${stateKey.slice('mcp:'.length)} (MCP)`
  if (stateKey.startsWith('skill:')) return `${stateKey.slice('skill:'.length)} (skill)`
  if (stateKey.startsWith('extension:')) return `${stateKey.slice('extension:'.length)} (extension)`
  return stateKey
}

/** PURE: the preset's deltas resolved over THIS screen's enumerated rows —
 *  the same closed-membership composition the menu's own carry uses
 *  (resolvedKitOf), with the preset's states instead of the record's, PLUS
 *  the P6 OFF-CARRY: unmatched skill/extension OFF deltas land in the worn
 *  kit's skillsOff / extensions map (mirroring kitCompletion's off-carry
 *  on the coordinator road, its grammar filters included) so both doors
 *  reach the SAME verdict on a later-born member. Unmatched MCP names and
 *  unmatched invocable states genuinely do not bite and land in
 *  `unmatched`, in receipt words. A snapshot the wire would refuse is a
 *  typed refusal, never an armed lie. */
export function resolvePresetWear(rows: readonly KitRow[], deltas: KitDeltasShape): PresetWearResolution {
  const states = statesFromDeltas(deltas)
  const known = new Set<string>()
  for (const row of rows) {
    const key = kitStateKey(row)
    if (key !== null) known.add(key)
  }
  const unmatchedKeys = [...states.keys()].filter(key => !known.has(key))
  const kit = resolvedKitOf(rows, states)
  const unmatched: string[] = []
  const keptOff: string[] = []
  // The off-carry (grammar-filtered exactly like the completion's: an
  // ill-grammared name cannot ride the wire and stays a doesn't-bite row).
  const carrySkillsOff: string[] = []
  const carryExtensionsOff: string[] = []
  for (const key of unmatchedKeys) {
    const state = states.get(key)
    if (key.startsWith('skill:') && state === 'off' && isKitSkillName(key.slice('skill:'.length))) {
      carrySkillsOff.push(key.slice('skill:'.length))
      keptOff.push(unmatchedWordOf(key))
    } else if (key.startsWith('extension:') && state === 'off' && isKitExtensionName(key.slice('extension:'.length))) {
      carryExtensionsOff.push(key.slice('extension:'.length))
      keptOff.push(unmatchedWordOf(key))
    } else {
      unmatched.push(unmatchedWordOf(key))
    }
  }
  if (carrySkillsOff.length > 0) kit.skillsOff = [...(kit.skillsOff ?? []), ...carrySkillsOff]
  if (carryExtensionsOff.length > 0) {
    kit.extensions = { ...(kit.extensions ?? {}) }
    for (const name of carryExtensionsOff) kit.extensions[name] = 'off'
  }
  // The wire's narrowing LAST (it rebuilds the kit in the schema's
  // declaration order — the armed bytes are canonical whatever order the
  // carry assigned).
  const verdict = validateSessionKit(kit)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  return { ok: true, kit: verdict.kit, unmatched, keptOff }
}

export type PresetWearReceipt = { ok: true; receipt: string } | { ok: false; reason: string }

/** THE ARM: resolve the named preset over the live rows and set the
 *  ONE-SHOT worn kit for the immediately-next birth. Unknown or damaged
 *  presets refuse typed (the store's own words); a refused resolution arms
 *  NOTHING and says so. The receipt states the one-shot law and names
 *  every delta that does not bite in this repo. */
export function wearPresetForNextSession(name: string, rows: readonly KitRow[]): PresetWearReceipt {
  const resolved = kitPresetDeltas(name)
  if (!resolved.ok) return { ok: false, reason: resolved.reason }
  const wear = resolvePresetWear(rows, resolved.deltas)
  if (!wear.ok) return { ok: false, reason: `preset '${name}' not worn — ${wear.reason}` }
  setNextSessionFacts({ presetKit: { name, kit: wear.kit } })
  const count = presetDeltaCount(resolved.deltas)
  const kept =
    wear.keptOff.length > 0
      ? ` · ${wear.keptOff.length} off delta${wear.keptOff.length === 1 ? '' : 's'} name${wear.keptOff.length === 1 ? 's' : ''} members this repo lacks (${wear.keptOff.join(', ')}) — kept off by name`
      : ''
  const bite =
    wear.unmatched.length > 0
      ? ` · ${wear.unmatched.length} of its ${count} delta${count === 1 ? '' : 's'} name${wear.unmatched.length === 1 ? 's' : ''} members this repo lacks (${wear.unmatched.join(', ')}) — they don't bite`
      : ''
  return { ok: true, receipt: `next session wears preset '${name}' — one-shot: the menu's default resumes after${kept}${bite}` }
}

/** THE DISARM (the one-keystroke undo): the armed wear cleared, nothing
 *  else touched. Answers honestly when nothing was armed. */
export function disarmWornPreset(): PresetWearReceipt {
  const worn = peekWornPresetKit()
  if (worn === null) return { ok: false, reason: 'no preset is armed — the menu\'s default stands' }
  setNextSessionFacts({ presetKit: null })
  return { ok: true, receipt: `preset '${worn.name}' disarmed — the menu's default stands` }
}
