import type { TensorFoldPickerFacts, TensorFoldRowAct } from '../../components/tensorfold/tensorfoldRows.js'
import { gibWords, tokensWords } from '../../services/localServer/localServerMemory.js'
import type { TensorFoldModelRow } from '../../services/tensorfold/contracts.js'
import type { TensorFoldInventoryRow } from '../../services/tensorfold/inventory.js'
import { bestTensorFoldFit } from '../../services/tensorfold/inventory.js'
import { TENSORFOLD_MODEL_PREFIX, type TensorFoldAct, type TensorFoldOutsideServer, type TensorFoldPanelFacts } from './scene.js'

export type { TensorFoldAct as TensorFoldPickerAct } from '../../components/tensorfold/tensorfoldRows.js'

export function rowActOf(act: TensorFoldAct | undefined, row: TensorFoldInventoryRow, usableGib: number | undefined, window: number): TensorFoldRowAct | undefined {
  if (act === undefined) return undefined
  switch (act.kind) {
    case 'pulling':
      return { phase: 'pulling', ...(act.percent !== undefined ? { percent: act.percent } : {}) }
    case 'starting':
      return { phase: 'starting', seconds: act.seconds }
    case 'refused':
      return {
        phase: 'refused',
        line: act.words,
        window: act.nextWindow ?? window,
        strip: windowStripWords(act, row, act.nextWindow ?? window, usableGib),
        ...(act.command !== undefined && act.cost !== undefined ? { limit: { command: act.command, cost: act.cost } } : {}),
      }
    case 'exited':
      return { phase: 'exited', line: act.line }
    case 'tight':
      return { phase: 'refused', line: tightWords(act), window }
    default:
      return undefined
  }
}

export function tightWords(act: { needBytes: number; freeBytes: number; offers: readonly string[] }): string {
  return [`${gibWords(act.needBytes)} needed · ${gibWords(act.freeBytes)} free on this Mac`, ...act.offers].join(' · ')
}

export function windowStripWords(act: TensorFoldAct | undefined, row: TensorFoldInventoryRow, window: number, usableGib: number | undefined): string {
  if (act?.kind === 'refused') {
    if (act.refusal.kind === 'gpu-limit' && window === (row.ladder?.[0]?.window ?? window)) return 'already the smallest window'
    if (act.cacheGibAt !== undefined && act.leftGib !== undefined) return `${tokensWords(window)} takes ${act.cacheGibAt.toFixed(1)} GiB of cache · ${act.leftGib.toFixed(2)} GiB left`
  }
  const rung = row.ladder?.find(candidate => candidate.window === window)
  if (rung !== undefined && rung.fit.verdict !== 'fits') {
    const fitting = row.ladder?.filter(candidate => candidate.fit.verdict === 'fits')
    const best = fitting?.[fitting.length - 1]
    const room = best !== undefined ? `← ${tokensWords(best.window)} fits` : 'no window fits this machine'
    return `${tokensWords(window)} needs ${gibWords(rung.fit.neededGib * 1024 ** 3)}, ${usableGib !== undefined ? gibWords(usableGib * 1024 ** 3) : '?'} usable · ${room}`
  }
  if (row.state === 'serving') return window === row.window ? '←→ restarts it at another window' : `↵ restarts it at ${tokensWords(window)}`
  return '←→ changes it'
}

export function outsideRowOf(server: TensorFoldOutsideServer): TensorFoldModelRow {
  return {
    repo: server.name,
    shortName: server.name,
    family: '',
    state: 'serving',
    fit: { verdict: 'fits', neededGib: 0, availableGib: 0, estimate: true },
    window: server.window ?? 0,
    qualified: true,
    port: server.port,
    startedBy: 'outside',
    ...(server.inUseBytes !== undefined ? { inUseBytes: server.inUseBytes } : {}),
    ...(server.lastReply !== undefined ? { lastReply: server.lastReply } : {}),
  }
}

export function pickerFactsOf(facts: TensorFoldPanelFacts): TensorFoldPickerFacts {
  const acts: Record<string, TensorFoldRowAct> = {}
  for (const row of facts.rows) {
    const act = rowActOf(facts.acts[row.repo], row, facts.machine.usableGib, row.window)
    if (act !== undefined) acts[row.repo] = act
  }
  const install = facts.install
  const installing = facts.acts.install
  const installFacts: TensorFoldPickerFacts['install'] | undefined =
    install === null || install.kind === 'windows'
      ? undefined
      : install.kind === 'brew' || install.kind === 'archive'
        ? { road: install.kind, commands: install.commands, ...(installing?.kind === 'installing' ? { state: 'installing' as const, ...(installing.line !== undefined ? { progress: installing.line } : {}) } : {}) }
        : { road: facts.platform === 'darwin' ? ('brew' as const) : ('archive' as const), state: 'unavailable' as const, commands: [] }
  const rows = facts.rows.map(row => ({ ...row, port: row.port ?? facts.port.next, ...(facts.acts[row.repo]?.kind === 'starting' ? { state: 'loading' as const } : {}) }))
  const best = bestTensorFoldFit(facts.rows)
  return {
    platform: facts.platform,
    engine: facts.engine,
    machine: { chip: facts.machine.chip, ...(facts.machine.usableGib !== undefined ? { usableGib: facts.machine.usableGib } : {}) },
    rows: [...facts.outside.map(outsideRowOf), ...rows],
    ...(best !== null ? { best: best.repo } : {}),
    served: [...facts.served],
    hosts: [...facts.hosts],
    ...(facts.helper !== undefined ? { helper: facts.helper } : {}),
    acts,
    ...(installFacts !== undefined ? { install: installFacts } : {}),
    ...(facts.keyed !== undefined ? { keyed: facts.keyed.address } : {}),
    ...(facts.port.busy !== undefined ? { port: { port: facts.port.next, taken: facts.port.busy.port, by: facts.port.busy.answersAs ?? 'another server', ...(facts.port.busy.answersAs === 'TensorFold' ? { keyed: true } : {}) } } : {}),
    ...(facts.app !== undefined ? { app: { serving: facts.app } } : {}),
    ...(facts.other !== undefined ? { other: { ...(facts.other.refused !== undefined ? { refused: facts.other.refused } : {}), ...(facts.other.read !== undefined ? { read: facts.other.read } : {}) } } : {}),
    ...(facts.disk !== undefined ? { disk: { into: facts.disk.cacheWords, freeBytes: facts.disk.freeBytes } } : {}),
    ...(facts.rent !== undefined ? { rent: facts.rent } : {}),
    pods: facts.pods,
  }
}

export function modelIdOf(row: Pick<TensorFoldModelRow, 'shortName'>): string {
  return `${TENSORFOLD_MODEL_PREFIX}${row.shortName}`
}
