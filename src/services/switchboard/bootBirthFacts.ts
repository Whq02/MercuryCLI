// ============================================================================
//  switchboard/bootBirthFacts — THE NEXT-SESSION FACTS (the operator's word:
//  the boot menu's settings are the NEXT session's settings).
//
//  ONE record for the facts the next-born session runs with — never a
//  second store, and never a running session: a session owns its state, so
//  the writers here are plain record updates (no connector, no daemon op)
//  and the readers are the birth/resume doors alone, once per birth. The
//  boot's arm writes the CLI's word (main.tsx: `-n`, `--effort`, the
//  resolved posture, the runner options; `--model` rides the main-loop
//  override the precedence falls to); a settings surface writes through
//  setNextSessionFacts — the boot menu's seam. (The menu's env rows already
//  reach the next session through the daemon's per-admission settings
//  snapshot and the warm pool's drift guard; this record carries what env
//  cannot.)
//
//  ONE-SHOT vs STICKY: the title names ONE session (takeBootTitle clears it
//  at the first birth), and a WORN PRESET dresses ONE session
//  (takeWornPresetKit — the kit screen's presets layer arms it; the first
//  door that spreads birth facts consumes it and the menu's default
//  resumes); model, effort, permissionMode, runnerArgv and the kit are
//  sticky — every later birth this boot reads the same answer.
//
//  THE KIT (ledger L24(3)/(5)): the MCPs & Skills menu
//  writes the NEXT session's kit here (setNextSessionFacts({ kit })) — the
//  L18 road that carries the screen's own fresh menu truth to the birth and
//  to the resume door, ahead of the daemon's cached config view. ABSENT on
//  the wire when null (the daemon then derives from the workspace's menu
//  store), never `kit: null`: carriedKitOf is the one spelling both doors
//  spread.
// ============================================================================
import type { PermissionMode } from '../../types/permissions.js'
import type { SessionKitV1 } from '../../daemon/sessionKit.js'

export interface BootBirthFacts {
  /** `-n <name>`; ONE-SHOT — consumed by the first birth. */
  title: string | null
  /** The next session's model; null ⇒ the door's own inheritance, else the
   *  screen's main model (birthModelOf). STICKY. */
  model: string | null
  /** `--effort`; null = the session's own convention. STICKY. */
  effort: string | null
  /** The boot's RESOLVED posture (the CLI flag, else the settings' default,
   *  else `default`); null = the seat's own resolution. STICKY — and the
   *  resume doors read it too: the posture rides every resume the way it
   *  rides the first message. */
  permissionMode: PermissionMode | null
  /** The boot's runner-side options, verbatim. STICKY. */
  runnerArgv: readonly string[]
  /** The next session's kit — the menu's RESOLVED snapshot (the screen
   *  enumerates the roster); null = nothing carried, the daemon derives.
   *  STICKY, and the resume door reads it too: a reactivated session is
   *  RE-STAMPED from the current menu (the opposite of model/effort). */
  kit: SessionKitV1 | null
  /** A WORN PRESET (ledger L24(4) — the operator's own
   *  birth door): the preset's RESOLVED kit + its name, armed by the kit
   *  screen's presets layer for exactly ONE session. ONE-SHOT — it
   *  OUTRANKS the sticky kit at the door that consumes it
   *  (takeWornPresetKit), then the sticky menu carry / the daemon's
   *  derivation resumes: the menu's default, untouched throughout. The
   *  consuming doors are the birth (New Session — consumed at entry, the
   *  takeBootTitle law: at-most-once, a refused birth spends it visibly)
   *  and a DEAD-transcript resume (the operator armed it, then picked the
   *  session — that is the intent); a LIVE hop never consumes it (the
   *  daemon answers `liveHop` — nothing was re-stamped, nothing is spent). */
  presetKit: { name: string; kit: SessionKitV1 } | null
}

let facts: BootBirthFacts = { title: null, model: null, effort: null, permissionMode: null, runnerArgv: [], kit: null, presetKit: null }

/** The boot's write (main.tsx, the fresh-boot arm). */
export function setBootBirthFacts(next: Partial<BootBirthFacts>): void {
  facts = { ...facts, ...next, runnerArgv: [...(next.runnerArgv ?? facts.runnerArgv)] }
}

/** The settings surfaces' write door (the boot menu's seam): the SAME
 *  record — a plain update; nothing running is ever touched. */
export const setNextSessionFacts = setBootBirthFacts

export function bootBirthFacts(): BootBirthFacts {
  return facts
}

/** The title rides ONE birth: the first taker consumes it. */
export function takeBootTitle(): string | null {
  const title = facts.title
  facts = { ...facts, title: null }
  return title
}

/** The armed wear, READ without spending it (the face's armed line; the
 *  resume door's peek — it spends only when the admit actually applied). */
export function peekWornPresetKit(): { name: string; kit: SessionKitV1 } | null {
  return facts.presetKit
}

/** THE WEAR rides ONE session: the first taker consumes it — the sticky
 *  kit (and everything else) is left exactly as it stands, so the menu's
 *  default resumes by construction. */
export function takeWornPresetKit(): { name: string; kit: SessionKitV1 } | null {
  const worn = facts.presetKit
  facts = { ...facts, presetKit: null }
  return worn
}

/** The birth's model precedence (pure): the record's model — the menu's
 *  explicit choice — outranks a door's own inheritance (/clear passes the
 *  cleared chat's model), which outranks the screen's main model. */
export function birthModelOf(record: Pick<BootBirthFacts, 'model'>, doorModel: string | null | undefined, screenModel: string): string {
  return record.model ?? doorModel ?? screenModel
}

/** THE KIT'S CARRY (pure): the admit frame's kit fragment — the record's
 *  kit when one is set, NOTHING when null. The field is ABSENT on the wire,
 *  never `kit: null` (the server's narrowing would refuse a null, and a
 *  stamped null would read as a kit). Both doors — the birth and the
 *  resume — spread exactly this. */
export function carriedKitOf(record: Pick<BootBirthFacts, 'kit'>): { kit: SessionKitV1 } | Record<string, never> {
  return record.kit !== null ? { kit: record.kit } : {}
}

/** Proof seam. */
export function _resetBootBirthFactsForTesting(): void {
  facts = { title: null, model: null, effort: null, permissionMode: null, runnerArgv: [], kit: null, presetKit: null }
}
