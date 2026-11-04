import type { ModelChoice } from '../../components/MercuryModelPicker.js'
import { tokensWords } from '../../services/localServer/localServerMemory.js'
import type { TensorFoldEngine, TensorFoldHost, TensorFoldMachine, TensorFoldModelRow, TensorFoldServed } from '../../services/tensorfold/contracts.js'
import type { TensorFoldInventoryRow } from '../../services/tensorfold/inventory.js'
import { tensorFoldWillRun } from '../../services/tensorfold/serve.js'
import type { ProviderHeading } from '../../utils/model/modelPickerGroups.js'
import { gibWords } from '../../services/localServer/localServerMemory.js'
import { bytesWords } from '../../services/host/bank.js'
import { TENSORFOLD_MODEL_PREFIX, type TensorFoldAct, type TensorFoldPanelFacts } from './scene.js'
import { TENSORFOLD_WORDS as W } from './words.js'

export type TensorFoldRowAct =
  | { phase: 'pulling'; percent?: number }
  | { phase: 'starting'; seconds?: number }
  | { phase: 'refused'; line: string; window?: number; strip?: string; limit?: { command: string; cost: string } }
  | { phase: 'exited'; line: string }

export type TensorFoldPickerFacts = {
  platform: NodeJS.Platform
  engine?: TensorFoldEngine | null
  machine?: TensorFoldMachine
  rows: TensorFoldModelRow[]
  best?: string
  served?: TensorFoldServed[]
  hosts?: TensorFoldHost[]
  acts?: Record<string, TensorFoldRowAct>
  install?: { road: 'brew' | 'archive'; state?: 'installing' | 'unavailable'; commands: string[]; progress?: string }
  keyed?: string
  port?: { port: number; taken: number; by: string; keyed?: boolean }
  other?: { refused?: string; read?: TensorFoldModelRow }
  disk?: { into: string; freeBytes?: number }
}

export type TensorFoldPickerAct =
  | { kind: 'serve'; row: TensorFoldModelRow; window: number }
  | { kind: 'stop'; row: TensorFoldModelRow }
  | { kind: 'support'; row?: TensorFoldModelRow; host?: TensorFoldHost; window?: number }
  | { kind: 'limit'; row: TensorFoldModelRow; line: string }
  | { kind: 'install' }
  | { kind: 'read'; repo: string }
  | { kind: 'address'; address: string }
  | { kind: 'rent' }
  | { kind: 'app'; serving: string }
  | { kind: 'share'; row: TensorFoldModelRow }
  | { kind: 'unshare'; row: TensorFoldModelRow }

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

export function pickerFactsOf(facts: TensorFoldPanelFacts): TensorFoldPickerFacts {
  const acts: Record<string, TensorFoldRowAct> = {}
  for (const row of facts.rows) {
    const act = rowActOf(facts.acts[row.repo], row, facts.machine.usableGib, facts.windows[row.repo] ?? row.window)
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
  return {
    platform: facts.platform,
    engine: facts.engine,
    machine: { chip: facts.machine.chip, ...(facts.machine.usableGib !== undefined ? { usableGib: facts.machine.usableGib } : {}) },
    rows: facts.rows.map(row => ({ ...row, window: facts.windows[row.repo] ?? row.window })),
    ...(facts.landing !== undefined ? { best: facts.landing } : {}),
    served: [...facts.served],
    hosts: [...facts.hosts],
    acts,
    ...(installFacts !== undefined ? { install: installFacts } : {}),
    ...(facts.keyed !== undefined ? { keyed: facts.keyed.address } : {}),
    ...(facts.port.busy !== undefined ? { port: { port: facts.port.next, taken: facts.port.busy.port, by: facts.port.busy.answersAs ?? 'another server', ...(facts.port.busy.answersAs === 'TensorFold' ? { keyed: true } : {}) } } : {}),
    ...(facts.other !== undefined ? { other: { ...(facts.other.refused !== undefined ? { refused: facts.other.refused } : {}), ...(facts.other.read !== undefined ? { read: facts.other.read } : {}) } } : {}),
    ...(facts.disk !== undefined ? { disk: { into: facts.disk.cacheWords, freeBytes: facts.disk.freeBytes } } : {}),
  }
}

export function usableWords(facts: Pick<TensorFoldPanelFacts, 'machine'>): string {
  return facts.machine.usableGib === undefined ? '' : `${gibWords(facts.machine.usableGib * 1024 ** 3)} usable`
}

export function headingStatusOf(facts: Pick<TensorFoldPanelFacts, 'platform' | 'engine' | 'machine' | 'served' | 'outside' | 'acts' | 'keyed' | 'install'>): string {
  if (facts.platform === 'win32') return W.windows
  const chip = facts.machine.chip
  const usable = usableWords(facts)
  if (facts.engine === null) return [W.notInstalled, chip, usable].filter(part => part !== '').join(' · ')
  if (facts.keyed !== undefined) return `${facts.engine.version} · ${facts.keyed.address} asks for a key`
  const starting = Object.values(facts.acts).filter(act => act.kind === 'starting').length
  const serving = facts.served.length + facts.outside.length
  const tail = starting > 0 ? `${starting} starting` : serving > 0 ? `${serving} serving` : W.nothingServed
  const inUse = facts.outside.reduce((sum, server) => sum + (server.inUseBytes ?? 0), 0)
  const left = inUse > 0 && facts.machine.usableGib !== undefined ? `${(facts.machine.usableGib - inUse / 1024 ** 3).toFixed(1)} of ${usable} left` : usable
  return [facts.engine.version, chip, left, tail].filter(part => part !== '').join(' · ')
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

export function memoryWords(row: Pick<TensorFoldModelRow, 'fit'>): string {
  const parts = row.fit.parts
  if (parts === undefined) return `${gibWords(row.fit.neededGib * 1024 ** 3)} · an estimate`
  const gib1 = (value: number): string => value.toFixed(1).replace(/\.0$/, '')
  const words = [`weights ${gib1(parts.weightsGib)}`, ...(parts.drafterGib !== undefined ? [`drafter ${gib1(parts.drafterGib)}`] : []), `cache ${gib1(parts.cacheGib)}`, ...(parts.promptCacheGib !== undefined ? [`prompt cache ${gib1(parts.promptCacheGib)}`] : []), `runtime ${gib1(parts.runtimeGib)}`]
  return `${words.join(' + ')} GiB${parts.promptCacheCapGib !== undefined ? ` · prompt cache ≤${parts.promptCacheCapGib} GiB` : ''}`
}

export function pullWords(facts: Pick<TensorFoldPanelFacts, 'disk'>): string | undefined {
  if (facts.disk === undefined) return undefined
  return `into ${facts.disk.cacheWords} · ${bytesWords(facts.disk.freeBytes)} free on this disk`
}

export function portWords(facts: Pick<TensorFoldPanelFacts, 'port'>): string | undefined {
  if (facts.port.busy === undefined) return undefined
  const busy = facts.port.busy
  const answers = busy.answersAs === 'TensorFold' ? 'is the keyed TensorFold server' : `answers as ${busy.answersAs ?? 'another server'}`
  return `${facts.port.next} · ${busy.port} ${answers} · Mercury remembers it`
}

export function modelIdOf(row: Pick<TensorFoldModelRow, 'shortName'>): string {
  return `${TENSORFOLD_MODEL_PREFIX}${row.shortName}`
}

export function downloadWords(row: Pick<TensorFoldModelRow, 'downloadBytes'>): string {
  return `↓ ${bytesWords(row.downloadBytes ?? 0)}`
}

export function stateWords(row: TensorFoldInventoryRow, act: TensorFoldAct | undefined, window: number, current: boolean): { text: string; tone: 'faint' | 'teal' | 'amber' | 'info' | 'failure' } {
  if (act?.kind === 'pulling') return { text: `pulling ${act.percent ?? 0}%`, tone: 'info' }
  if (act?.kind === 'starting') return { text: 'starting', tone: 'info' }
  if (act?.kind === 'refused') return { text: 'refused', tone: 'failure' }
  if (act?.kind === 'exited') return { text: 'exited', tone: 'failure' }
  if (act?.kind === 'tight') return { text: 'does not fit', tone: 'amber' }
  if (row.state === 'serving') return current ? { text: 'current', tone: 'teal' } : { text: 'serving', tone: 'teal' }
  const rung = row.ladder?.find(candidate => candidate.window === window)
  if (rung !== undefined && rung.fit.verdict !== 'fits') return { text: 'does not fit', tone: 'amber' }
  if (row.state === 'on-disk') return { text: 'on disk', tone: 'faint' }
  return { text: downloadWords(row), tone: 'faint' }
}

export function tailWords(row: TensorFoldInventoryRow, window: number): { text: string; tone: 'faint' | 'teal' | 'amber' } {
  if (row.state === 'serving') return row.inUseBytes !== undefined ? { text: `${gibWords(row.inUseBytes)} in use`, tone: 'teal' } : { text: '', tone: 'teal' }
  const rung = row.ladder?.find(candidate => candidate.window === window)
  const fit = rung?.fit ?? row.fit
  return { text: gibWords(fit.neededGib * 1024 ** 3), tone: fit.verdict === 'fits' ? 'faint' : 'amber' }
}

export const TENSORFOLD_PICKER_GROUP = 'Mercury — TensorFold'
export const TENSORFOLD_HOST_PICKER_GROUP = 'Mercury — TensorFold host'

export function standInCard(facts: TensorFoldPanelFacts, row: TensorFoldInventoryRow): string {
  const window = facts.windows[row.repo] ?? row.window
  const act = facts.acts[row.repo]
  const state = stateWords(row, act, window, facts.current !== undefined && facts.current === modelIdOf(row))
  const lines: string[] = []
  if (act?.kind === 'refused') lines.push(`refused   ${act.words}`)
  if (act?.kind === 'exited') lines.push(`exited    ${act.line}`)
  if (act?.kind === 'tight') lines.push(`memory    ${tightWords(act)}`)
  lines.push(`window    ${(row.ladder ?? []).map(rung => (rung.window === window ? `[${tokensWords(rung.window)}]` : tokensWords(rung.window))).join(' ')} · ${windowStripWords(act, row, window, facts.machine.usableGib)}`)
  lines.push(`memory    ${memoryWords({ fit: row.ladder?.find(rung => rung.window === window)?.fit ?? row.fit })}`)
  const pull = pullWords(facts)
  if (row.state === 'not-pulled' && pull !== undefined) lines.push(`pull      ${pull}`)
  if (row.state === 'serving') lines.push(`service   tensorfold · started by Mercury${row.promptCacheGib !== undefined ? ` · prompt cache ${row.promptCacheGib} GiB` : ''}`)
  if (act?.kind === 'stop-confirm') lines.push(`stop      ${W.stopConfirm}`)
  if (act?.kind === 'refused' && act.command !== undefined && act.cost !== undefined) {
    lines.push(`will run  ${act.command}`)
    lines.push(`cost      ${act.cost}`)
  } else if (row.state !== 'serving' || window !== row.window) {
    const stopFirst = facts.served.length > 0 && facts.served[0]!.repo !== row.repo ? [`stop ${facts.served[0]!.name} on 127.0.0.1:${facts.served[0]!.port}`] : []
    const commands = [...stopFirst, ...tensorFoldWillRun({ ...row, port: facts.port.next }, window)]
    commands.forEach((command, at) => lines.push(`${at === 0 ? 'will run ' : '         '} ${command}`))
    const port = portWords(facts)
    if (port !== undefined) lines.push(`port      ${port}`)
  }
  const tail = tailWords(row, window)
  return [`${state.text}${tail.text !== '' ? ` · ${tail.text}` : ''}${row.fit.verdict !== 'fits' && act?.kind !== 'refused' ? ` · ${row.fit.reason ?? ''} · ${row.fit.remedy ?? ''}` : ''}`, ...lines].join('\n')
}

export function standInRows(facts: TensorFoldPanelFacts): { models: ModelChoice[]; headings: Record<string, ProviderHeading>; landing?: string } {
  const models: ModelChoice[] = []
  const heading = headingStatusOf(facts)
  const headings: Record<string, ProviderHeading> = {
    [TENSORFOLD_PICKER_GROUP]: { name: W.group, doors: [{ door: heading }] },
    [TENSORFOLD_HOST_PICKER_GROUP]: { name: W.hostGroup, doors: [{ door: facts.hosts.length === 0 ? W.hostNone : `${facts.hosts[0]!.name} · ${facts.hosts.length} serving` }] },
  }
  if (facts.platform !== 'win32' && facts.engine === null && facts.install !== null) {
    const install = facts.install
    const state = facts.acts.install?.kind === 'installing' ? '  ◐ installing' : install.kind === 'needs-brew' || install.kind === 'no-gpu' || install.kind === 'old-driver' ? '  unavailable' : ''
    const card = install.kind === 'brew' || install.kind === 'archive' ? install.commands.map((command, at) => `${at === 0 ? 'will run ' : '         '} ${command}`).join('\n') : `needs     ${install.kind === 'needs-brew' ? install.needs : install.words}`
    models.push({ id: 'tensorfold:install', name: `${W.installRow} — ${install.words}${state}`, tag: card, ctx: '', group: TENSORFOLD_PICKER_GROUP, action: true, searchableAction: true })
  }
  for (const row of facts.rows) {
    const window = facts.windows[row.repo] ?? row.window
    models.push({ id: modelIdOf(row), name: row.label, tag: standInCard(facts, row), ctx: `${tokensWords(window)} ctx`, group: TENSORFOLD_PICKER_GROUP })
  }
  for (const server of facts.outside) {
    models.push({ id: `tensorfold:outside:${server.port}`, name: server.name, tag: `window    ${server.window !== undefined ? tokensWords(server.window) : '?'} · ${W.startedOutside}`, ctx: server.window !== undefined ? `${tokensWords(server.window)} ctx` : '', group: TENSORFOLD_PICKER_GROUP })
  }
  if (facts.other?.read !== undefined) {
    const row = facts.other.read
    models.push({ id: modelIdOf(row), name: row.label, tag: standInCard(facts, row), ctx: `${tokensWords(facts.windows[row.repo] ?? row.window)} ctx`, group: TENSORFOLD_PICKER_GROUP })
  }
  if (facts.platform !== 'win32') {
    const other = facts.other
    const otherCard = other === undefined ? `reads     ${W.otherReads}` : other.refused !== undefined ? `repo      ${other.input}\nrefused   ${other.refused}` : `repo      ${other.input}\nreads     ${W.otherReads}`
    models.push({ id: 'tensorfold:other', name: `${W.otherRow} — ${W.otherWords}`, tag: otherCard, ctx: '', group: TENSORFOLD_PICKER_GROUP, action: true, searchableAction: true })
  }
  for (const host of facts.hosts) {
    models.push({ id: `tensorfold:host:${host.name}`, name: host.serving ?? host.name, tag: `host      ${host.name}${host.chip !== undefined ? ` · ${host.chip}` : ''}${host.version !== undefined ? ` · TensorFold ${host.version}` : ''}`, ctx: host.window !== undefined ? `${tokensWords(host.window)} ctx` : '', group: TENSORFOLD_HOST_PICKER_GROUP })
  }
  models.push({ id: 'tensorfold:address', name: `${W.addressRow} — ${W.addressWords}`, tag: '', ctx: '', group: TENSORFOLD_HOST_PICKER_GROUP, action: true, searchableAction: true })
  const landed = facts.landing === undefined ? undefined : facts.rows.find(row => row.repo === facts.landing)
  const landing = facts.landing === undefined ? undefined : facts.landing === 'install' ? 'tensorfold:install' : facts.landing.startsWith('outside:') ? `tensorfold:${facts.landing}` : landed !== undefined ? modelIdOf(landed) : undefined
  return { models, headings, ...(landing !== undefined ? { landing } : {}) }
}
