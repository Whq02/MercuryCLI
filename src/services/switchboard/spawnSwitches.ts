import { flagSpellings } from '../../substrate/flagRegistry.js'
import { realEnvPin } from '../../substrate/startupMenu.js'

export type SpawnSwitchKind = 'subagents' | 'workflows'

export type SpawnSwitchSource = 'default' | 'boot-menu' | 'env' | 'in-session'

export interface SpawnSwitchState {
  on: boolean
  source: SpawnSwitchSource
}

export type SpawnSwitchFacts = Record<SpawnSwitchKind, SpawnSwitchState>

export const SPAWN_SWITCH_KINDS: readonly SpawnSwitchKind[] = ['subagents', 'workflows']

export const SPAWN_SWITCH_ENV: Record<SpawnSwitchKind, string> = {
  subagents: 'MERCURY_SESSION_SUBAGENTS',
  workflows: 'MERCURY_SESSION_WORKFLOWS',
}

export const SPAWN_SWITCH_LABEL: Record<SpawnSwitchKind, string> = {
  subagents: 'sub-agents',
  workflows: 'workflows',
}

export const SPAWN_SWITCH_COMMAND: Record<SpawnSwitchKind, string> = {
  subagents: '/subagents',
  workflows: '/workflows',
}

const SPAWN_SWITCH_TOOL: Record<SpawnSwitchKind, string> = {
  subagents: 'the Agent tool',
  workflows: 'the Workflow tool',
}

export function spawnSwitchKindOfEnv(env: string): SpawnSwitchKind | null {
  for (const kind of SPAWN_SWITCH_KINDS) if (SPAWN_SWITCH_ENV[kind] === env) return kind
  return null
}

export function spawnSwitchOffReceipt(kind: SpawnSwitchKind): string {
  return `${SPAWN_SWITCH_LABEL[kind]} are off for this session — ${SPAWN_SWITCH_COMMAND[kind]} on, or the boot menu's Agents section`
}

export function spawnSwitchOnFromValue(value: string | null | undefined): boolean {
  return value !== '0'
}

export function bornSpawnSwitch(kind: SpawnSwitchKind, env: NodeJS.ProcessEnv = process.env): SpawnSwitchState {
  const row = SPAWN_SWITCH_ENV[kind]
  const value = flagSpellings(row)
    .map(spelling => env[spelling])
    .find(v => v !== undefined)
  if (value === undefined) return { on: true, source: 'default' }
  return { on: spawnSwitchOnFromValue(value), source: realEnvPin(row, env) !== null ? 'env' : 'boot-menu' }
}


let latched: Partial<Record<SpawnSwitchKind, SpawnSwitchState>> = {}

export function spawnSwitch(kind: SpawnSwitchKind): SpawnSwitchState {
  const held = latched[kind]
  if (held !== undefined) return held
  const born = bornSpawnSwitch(kind)
  latched = { ...latched, [kind]: born }
  return born
}

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

export function _resetSpawnSwitchesForTesting(): void {
  latched = {}
}


export interface SpawnSwitchRecordView {
  spawnSwitches?: Partial<Record<SpawnSwitchKind, 'on' | 'off'>>
  settingsSnapshot?: { rows: ReadonlyArray<{ env: string; value: string | null; source: 'process-env' | 'profile' | 'default' }> }
}

export function spawnSwitchOfRecord(rec: SpawnSwitchRecordView | undefined, kind: SpawnSwitchKind): SpawnSwitchState {
  const toggled = rec?.spawnSwitches?.[kind]
  if (toggled !== undefined) return { on: toggled === 'on', source: 'in-session' }
  const row = rec?.settingsSnapshot?.rows.find(r => r.env === SPAWN_SWITCH_ENV[kind])
  if (row === undefined || row.source === 'default') return { on: true, source: 'default' }
  return { on: spawnSwitchOnFromValue(row.value), source: row.source === 'process-env' ? 'env' : 'boot-menu' }
}

export function spawnSwitchFactsOfRecord(rec: SpawnSwitchRecordView | undefined): SpawnSwitchFacts {
  return { subagents: spawnSwitchOfRecord(rec, 'subagents'), workflows: spawnSwitchOfRecord(rec, 'workflows') }
}


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

export function spawnSwitchLine(kind: SpawnSwitchKind, state: SpawnSwitchState): string {
  return `${SPAWN_SWITCH_LABEL[kind]} ${state.on ? 'on' : 'off'} (${spawnSwitchSourceLabel(state.source)})`
}

export function spawnSwitchBoundaryNote(kind: SpawnSwitchKind, on: boolean): string {
  return on
    ? `${SPAWN_SWITCH_TOOL[kind]} rejoins the roster from the next turn; reasoning restarts on the next turn`
    : `${SPAWN_SWITCH_TOOL[kind]} leaves the roster from the next turn; reasoning restarts on the next turn; a spawn already running finishes`
}

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

export function spawnSwitchTransitionLine(kind: SpawnSwitchKind, on: boolean): string {
  return `the operator toggled ${SPAWN_SWITCH_LABEL[kind]} ${on ? 'on' : 'off'} for this session — ${spawnSwitchBoundaryNote(kind, on)}`
}

export function parseSpawnSwitchArg(raw: string): { op: 'on' | 'off' | 'show' } | { op: 'unknown'; word: string } {
  const word = raw.trim().toLowerCase()
  if (word === '') return { op: 'show' }
  if (word === 'on' || word === 'off') return { op: word }
  return { op: 'unknown', word }
}
