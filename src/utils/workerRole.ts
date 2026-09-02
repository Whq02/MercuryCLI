// ============================================================================
//  workerRole — the role discriminator for daemon-spawned workers, and the
//  ONE roster of role env vars every role-hygiene seam sweeps.
//
//  A process is a crew teammate XOR a concourse session worker XOR neither —
//  never two roles at once. The daemon spawns each child with exactly one
//  role marker set (a cloned env, never the supervisor's own); the
//  foreground the operator launches carries none.
//
//  Two roster halves:
//    · LIVE roles read through the registry (flagEnv — the registration
//      check for free): MERCURY_CONCOURSE_WORKER, plus the crew pair, which
//      is dual-polarity ('0' = the operator's default-on kill, '1' = the
//      daemon-stamped role) and so is read here by its exact role value.
//    · RETIRED seat markers: nothing in the tree sets them any more, but an
//      operator shell (or a stale supervisor env) still can, so the spawn
//      strip, the supervisor scrub and the single-role guard keep sweeping
//      the spellings RAW — their registry rows died with their estate, and
//      flagEnv THROWS on an unregistered name.
// ============================================================================
import { flagEnv } from '../substrate/flagRegistry.js'

/** The retired seat markers, swept raw (see the header). */
export const RETIRED_SEAT_ENV_VARS: readonly string[] = [
  'MERCURY_TANK',
  'MERCURY_HEALER',
  'MERCURY_DPS1',
  'MERCURY_DPS2',
  'MERCURY_DPS3',
]

/** The live role markers that resolve through the registry. The crew pair
 *  is deliberately absent (its '0' polarity is an operator kill a uniform
 *  delete-if-set strip would erase); stripCrewRolePair handles it. */
export const LIVE_ROLE_ENV_VARS: readonly string[] = ['MERCURY_CONCOURSE_WORKER']

export const ALL_ROLE_ENV_VARS: readonly string[] = [
  ...LIVE_ROLE_ENV_VARS,
  ...RETIRED_SEAT_ENV_VARS,
]

/** True only in a daemon-spawned CREW TEAMMATE (/teammates — role env
 *  MERCURY_CREW='1', the teammate's NAME in MERCURY_CREW_AGENT). Crew children
 *  ride the same bus + mailbox kernel as every other daemon worker, so they
 *  get the same bus-role guards (e.g. the SendMessage hand-serialized-envelope
 *  refusal) and the team-lead reply default. LITERAL dot read. */
export function isCrewRole(): boolean {
  return flagEnv('MERCURY_CREW') === '1'
}

/**
 * Fail loud if a process is somehow tagged with more than one role — that
 * would cross the persona/authority wiring. Called at engine construction so
 * a mis-spawn aborts instead of silently mixing two roles in one process.
 * The crew marker counts only in its role form ('1'): an operator's ='0'
 * kill is a gate value, not a role. The live roles read through the
 * registry (flagEnv); the retired spellings read RAW.
 */
export function assertSingleRole(): void {
  const liveSet = ['MERCURY_CREW', ...LIVE_ROLE_ENV_VARS].filter(v => flagEnv(v) === '1')
  const retiredSet = RETIRED_SEAT_ENV_VARS.filter(v => process.env[v] === '1')
  const set = [...liveSet, ...retiredSet]
  if (set.length > 1) {
    throw new Error(
      `a process must carry exactly ONE role env, but ${set.length} are set ` +
        `(${set.join(', ')}). Each spawned worker is a single role.`,
    )
  }
}
