// ============================================================================
//  switchboard/spawnSwitches — THE TWO SPAWN SWITCHES of a session: sub-agents
//  and workflows, on or off, per session.
//
//  ONE owner for the fact "may this session spawn sub-agents / run
//  workflows?" — the boot menu's Agents rows (MERCURY_SESSION_SUBAGENTS,
//  MERCURY_SESSION_WORKFLOWS: default on, `0` = off) reach a session at its
//  BIRTH through the boot-env road, and the in-session toggle (/subagents,
//  /workflows, the boot menu opened inside the session) moves the switch at
//  the session's next turn boundary. Every road that would spawn — the
//  launch-authority valve the Agent and Workflow tools ask, the skill fork,
//  the workflow's agent hooks, the fleet tools, the Crew view's spawn key —
//  reads the valve, and the valve reads this owner; nothing else decides it.
//
//  Two views of one truth:
//    · the SESSION PROCESS (the runner, the plain chat) latches its own
//      switches at first read from the env its boot applied (the birth
//      value, sticky for the session) and moves them when the daemon
//      forwards an in-session toggle;
//    · the DAEMON and the SCREEN read the session's durable record — an
//      in-session toggle the record carries, else the settings snapshot the
//      admission captured (the same env row, attributed by the same
//      boot-env law). spawnSwitchOfRecord answers that view.
//
//  The concourse coordinator's own launches (sessions, crew seats from the
//  concourse) never pass through here — the switches are per focused
//  session, never the estate's.
// ============================================================================
import { flagSpellings } from '../../substrate/flagRegistry.js'
import { realEnvPin, type EffectiveSettingRow } from '../../substrate/startupMenu.js'

export type SpawnSwitchKind = 'subagents' | 'workflows'

/** Where the session's current value came from. */
export type SpawnSwitchSource = 'default' | 'boot-menu' | 'env' | 'in-session'

export interface SpawnSwitchState {
  on: boolean
  source: SpawnSwitchSource
}

export type SpawnSwitchFacts = Record<SpawnSwitchKind, SpawnSwitchState>

export const SPAWN_SWITCH_KINDS: readonly SpawnSwitchKind[] = ['subagents', 'workflows']

/** The registered env row behind each switch (the boot menu's Agents rows). */
export const SPAWN_SWITCH_ENV: Record<SpawnSwitchKind, string> = {
  subagents: 'MERCURY_SESSION_SUBAGENTS',
  workflows: 'MERCURY_SESSION_WORKFLOWS',
}

/** The operator's word for each switch. */
export const SPAWN_SWITCH_LABEL: Record<SpawnSwitchKind, string> = {
  subagents: 'sub-agents',
  workflows: 'workflows',
}

/** The command that flips each switch inside a session. */
export const SPAWN_SWITCH_COMMAND: Record<SpawnSwitchKind, string> = {
  subagents: '/subagents',
  workflows: '/workflows',
}

/** What the switch removes from the roster while off. */
const SPAWN_SWITCH_TOOL: Record<SpawnSwitchKind, string> = {
  subagents: 'the Agent tool',
  workflows: 'the Workflow tool',
}

export function spawnSwitchKindOfEnv(env: string): SpawnSwitchKind | null {
  for (const kind of SPAWN_SWITCH_KINDS) if (SPAWN_SWITCH_ENV[kind] === env) return kind
  return null
}

/** The ONE receipt every spawn road answers while the switch is off. */
export function spawnSwitchOffReceipt(kind: SpawnSwitchKind): string {
  return `${SPAWN_SWITCH_LABEL[kind]} are off for this session — ${SPAWN_SWITCH_COMMAND[kind]} on, or the boot menu's Agents section`
}

/** The row's own value: `0` is off; anything else (unset included) is on. */
export function spawnSwitchOnFromValue(value: string | null | undefined): boolean {
  return value !== '0'
}

/**
 * The switch a session is BORN with: the env row the boot applied, with its
 * attribution — a value the real environment holds is 'env', the boot's own
 * copy of a saved default is 'boot-menu' (realEnvPin, the one attribution
 * owner, tells them apart), an unset row is the default.
 */
export function bornSpawnSwitch(kind: SpawnSwitchKind, env: NodeJS.ProcessEnv = process.env): SpawnSwitchState {
  const row = SPAWN_SWITCH_ENV[kind]
  const value = flagSpellings(row)
    .map(spelling => env[spelling])
    .find(v => v !== undefined)
  if (value === undefined) return { on: true, source: 'default' }
  return { on: spawnSwitchOnFromValue(value), source: realEnvPin(row, env) !== null ? 'env' : 'boot-menu' }
}

// ── the session process's own switches ──────────────────────────────────────
//  Latched at first read (the birth value — the env is the boot's, applied
//  before anything reads it) and moved only by an in-session toggle. A
//  later profile save never reaches a running session: the boot menu's
//  rows are the NEXT session's settings.

let latched: Partial<Record<SpawnSwitchKind, SpawnSwitchState>> = {}

export function spawnSwitch(kind: SpawnSwitchKind): SpawnSwitchState {
  const held = latched[kind]
  if (held !== undefined) return held
  const born = bornSpawnSwitch(kind)
  latched = { ...latched, [kind]: born }
  return born
}

/** THE IN-SESSION TOGGLE's landing (the session process): the switch moves
 *  now — the caller lands it at a turn boundary (the daemon parks a
 *  mid-turn toggle and forwards it at the idle edge; the runner defers one
 *  that still arrives mid-turn to its turn's end). */
export function setSpawnSwitch(kind: SpawnSwitchKind, on: boolean): { changed: boolean; state: SpawnSwitchState } {
  const before = spawnSwitch(kind)
  if (before.on === on && before.source === 'in-session') return { changed: false, state: before }
  const state: SpawnSwitchState = { on, source: 'in-session' }
  latched = { ...latched, [kind]: state }
  return { changed: before.on !== on, state }
}

export function spawnSwitchFacts(): SpawnSwitchFacts {
  return { subagents: spawnSwitch('subagents'), workflows: spawnSwitch('workflows') }
}

/** Proof seam: forget the latches (a fresh birth). */
export function _resetSpawnSwitchesForTesting(): void {
  latched = {}
}

// ── the record's view (the daemon, the screen) ──────────────────────────────

/** The slice of a session's durable record the switches read. */
export interface SpawnSwitchRecordView {
  /** In-session toggles the daemon applied (the durable truth a respawn
   *  re-forwards); absent = never toggled. */
  spawnSwitches?: Partial<Record<SpawnSwitchKind, 'on' | 'off'>>
  /** The admission's settings snapshot (the env rows at birth). */
  settingsSnapshot?: { rows: ReadonlyArray<Pick<EffectiveSettingRow, 'env' | 'value' | 'source'>> }
}

export function spawnSwitchOfRecord(rec: SpawnSwitchRecordView | undefined, kind: SpawnSwitchKind): SpawnSwitchState {
  const toggled = rec?.spawnSwitches?.[kind]
  if (toggled !== undefined) return { on: toggled === 'on', source: 'in-session' }
  const row = rec?.settingsSnapshot?.rows.find(r => r.env === SPAWN_SWITCH_ENV[kind])
  if (row === undefined || row.source === 'default') return { on: true, source: 'default' }
  // The snapshot's verdict is the boot-env owner's (realEnvPin decided it at
  // admission): a profile row is the boot menu's, anything else the
  // environment's pin.
  return { on: spawnSwitchOnFromValue(row.value), source: row.source === 'profile' ? 'boot-menu' : 'env' }
}

export function spawnSwitchFactsOfRecord(rec: SpawnSwitchRecordView | undefined): SpawnSwitchFacts {
  return { subagents: spawnSwitchOfRecord(rec, 'subagents'), workflows: spawnSwitchOfRecord(rec, 'workflows') }
}

// ── the words ───────────────────────────────────────────────────────────────

export function spawnSwitchSourceLabel(source: SpawnSwitchSource): string {
  switch (source) {
    case 'boot-menu':
      return 'boot menu'
    case 'in-session':
      return 'in-session'
    case 'env':
      return 'environment'
    case 'default':
      return 'default'
  }
}

/** One switch, stated: "sub-agents on (boot menu)". */
export function spawnSwitchLine(kind: SpawnSwitchKind, state: SpawnSwitchState): string {
  return `${SPAWN_SWITCH_LABEL[kind]} ${state.on ? 'on' : 'off'} (${spawnSwitchSourceLabel(state.source)})`
}

/** What the toggle does at the boundary — the sentence every receipt carries. */
export function spawnSwitchBoundaryNote(kind: SpawnSwitchKind, on: boolean): string {
  return on
    ? `${SPAWN_SWITCH_TOOL[kind]} rejoins the roster from the next turn; reasoning restarts on the next turn`
    : `${SPAWN_SWITCH_TOOL[kind]} leaves the roster from the next turn; reasoning restarts on the next turn; a spawn already running finishes`
}

/** The toggle's receipt from the settlement owner's word: applied (landed
 *  at this boundary), queued (mid-turn — lands when the turn ends), noop
 *  (already so), refused (the detail says why). */
export function spawnSwitchToggleReceipt(
  kind: SpawnSwitchKind,
  on: boolean,
  outcome: 'applied' | 'queued' | 'noop' | 'refused',
  detail?: string,
): string {
  const label = SPAWN_SWITCH_LABEL[kind]
  switch (outcome) {
    case 'applied':
      return `${label} ${on ? 'on' : 'off'} for this session — ${spawnSwitchBoundaryNote(kind, on)}`
    case 'queued':
      return `${label} ${on ? 'on' : 'off'} for this session — applies when this turn ends: ${spawnSwitchBoundaryNote(kind, on)}`
    case 'noop':
      return `${label} already ${on ? 'on' : 'off'} for this session`
    case 'refused':
      return `${label} ${on ? 'on' : 'off'} refused — ${detail ?? 'the session did not take the toggle'}`
  }
}

/** The transcript row's sentence for a landed toggle (the roster-transition
 *  mark the preserved-thinking reading treats as a lawful prefix change). */
export function spawnSwitchTransitionLine(kind: SpawnSwitchKind, on: boolean): string {
  return `the operator toggled ${SPAWN_SWITCH_LABEL[kind]} ${on ? 'on' : 'off'} for this session — ${spawnSwitchBoundaryNote(kind, on)}`
}

/** Parse a command argument: on · off · (empty = a readout). */
export function parseSpawnSwitchArg(raw: string): { op: 'on' | 'off' | 'show' } | { op: 'unknown'; word: string } {
  const word = raw.trim().toLowerCase()
  if (word === '') return { op: 'show' }
  if (word === 'on' || word === 'off') return { op: word }
  return { op: 'unknown', word }
}
