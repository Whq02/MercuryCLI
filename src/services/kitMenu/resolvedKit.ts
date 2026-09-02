// ============================================================================
//  services/kitMenu/resolvedKit — THE L18 CARRY (the operator's L18 applied
//  to the kit; the lead's ruling): the
//  MCPs & Skills screen hands the NEXT session's kit to the birth through
//  setNextSessionFacts({ kit }) — the PRIMARY road for the immediately-next
//  birth from THIS screen. It exists to kill the config-cache race: the
//  daemon's config view is a watcher-refreshed CACHE that can be stale for
//  a birth one keystroke after a menu edit ("flip a switch, start a session,
//  it obeys" — the operator's example), so the screen carries its own fresh
//  truth. The daemon's workspace-keyed derivation is
//  the FALLBACK for births the screen never sees — a coordinator
//  launch_session, another terminal — and for a record this boot never
//  edited (nothing is carried until a write: a resolved snapshot is a CLOSED
//  membership and sticky for the boot, so an untouched menu leaves the
//  derivation — and a member added later — to answer).
//
//  RESOLVED = closed membership (the screen enumerated the roster): the
//  lists ARE what the born session runs — every EFFECTIVE on (an item under
//  an OFF extension master is off, whatever its own state says), the
//  invocable skills apart, the master rows by name. Validated through the
//  wire's own narrowing BEFORE it is carried: a kit the admit would refuse
//  is never carried (the birth then derives), and the refusal is said in
//  words on the receipt — never a silently dropped kit, never a refused birth.
// ============================================================================
import { validateSessionKit, type SessionKitV1 } from '../../daemon/sessionKit.js'
import { setNextSessionFacts } from '../switchboard/bootBirthFacts.js'
import { kitRowView, type KitRow, type KitStates } from './kitTypes.js'

/** PURE: the screen's RESOLVED snapshot over the enumerated rows and the
 *  record's states. A resolved kit omits `resolved`; `extensions` is
 *  absent when the roster names no extension. */
export function resolvedKitOf(rows: readonly KitRow[], states: KitStates): SessionKitV1 {
  const kit: SessionKitV1 = { schema: 1, mcp: [], skills: [], invocable: [] }
  const extensions: Record<string, 'on' | 'off'> = {}
  for (const row of rows) {
    if (row.kind === 'mcp') {
      if (kitRowView(row, states).effective === 'on' && !kit.mcp.includes(row.name)) kit.mcp.push(row.name)
    } else if (row.kind === 'skill') {
      const effective = kitRowView(row, states).effective
      if (effective === 'on' && !kit.skills.includes(row.name)) kit.skills.push(row.name)
      else if (effective === 'invocable' && !kit.invocable.includes(row.name)) kit.invocable.push(row.name)
    } else if (row.kind === 'extension') {
      extensions[row.name] = kitRowView(row, states).own === 'off' ? 'off' : 'on'
    }
  }
  if (Object.keys(extensions).length > 0) kit.extensions = extensions
  return kit
}

export type KitCarryReceipt = { carried: true } | { carried: false; reason: string }

/** The carry: the next-session record takes the RESOLVED snapshot — after
 *  the wire's own narrowing accepts it. */
export function carryNextSessionKit(rows: readonly KitRow[], states: KitStates): KitCarryReceipt {
  const validation = validateSessionKit(resolvedKitOf(rows, states))
  if (!validation.ok) return { carried: false, reason: validation.reason }
  setNextSessionFacts({ kit: validation.kit })
  return { carried: true }
}
