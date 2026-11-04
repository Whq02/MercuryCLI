import * as React from 'react'
import { MercuryModelPicker } from '../../components/MercuryModelPicker.js'
import { ModelPickerPopupLease } from '../../components/ModelPickerPopupSlot.js'
import { focusedSessionModelFacts } from '../../services/engine-connector/focusedConnector.js'
import { pickAndProve } from '../../services/localSetup/setupProve.js'
import { rememberTensorFoldHost } from '../../services/providers/local/tensorfoldHosts.js'
import type { TensorFoldEngineFound } from '../../services/tensorfold/engine.js'
import type { TensorFoldInventoryRow } from '../../services/tensorfold/inventory.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { claimModelPickerPopup } from '../../utils/cockpit/modelPickerPopup.js'
import { getEngineModel } from '../../utils/model/model.js'
import { modelIdOf, pickerFactsOf, standInRows, type TensorFoldPickerAct } from './pickerFacts.js'
import {
  SHARE_WORDS,
  UNSHARE_WORDS,
  copyTensorFoldSupportLine,
  copyWiredLimitCommand,
  discoveryEnvFor,
  installTensorFoldThen,
  keepTensorFoldRow,
  readOtherCheckpoint,
  serveTensorFoldRow,
  setTensorFoldNotice,
  stopTensorFoldRow,
  subscribeTensorFoldRoad,
  supportFocusOf,
  switchToTensorFold,
  tensorFoldRoadState,
  tensorFoldRoadVersion,
  windowOf,
  type RoadIo,
} from './road.js'
import { readTensorFoldPanelFacts, servedAddress, type FactsIo, type TensorFoldPanelFacts } from './scene.js'
import { TENSORFOLD_WORDS as W } from './words.js'

export const TENSORFOLD_REFRESH_MS = 1_000

export type TensorFoldPanelIo = { facts?: FactsIo; road?: RoadIo; current?: () => string | undefined }

function currentModelId(): string | undefined {
  try {
    return focusedSessionModelFacts()?.effective ?? getEngineModel()
  } catch {
    return undefined
  }
}

export function TensorFoldPanel({ onDone, io = {}, repo }: { onDone: (words?: string) => void; io?: TensorFoldPanelIo; repo?: string }): React.ReactNode {
  const version = React.useSyncExternalStore(subscribeTensorFoldRoad, tensorFoldRoadVersion, tensorFoldRoadVersion)
  const [facts, setFacts] = React.useState<TensorFoldPanelFacts | null>(null)
  const engineRef = React.useRef<TensorFoldEngineFound | null | undefined>(undefined)
  const alive = React.useRef(true)
  const read = React.useCallback(async (again = false): Promise<void> => {
    if (again) engineRef.current = undefined
    const current = io.current?.() ?? currentModelId()
    const state = tensorFoldRoadState()
    const next = await readTensorFoldPanelFacts({ ...io.facts, ...(current !== undefined ? { current } : {}), ...(engineRef.current !== undefined ? { engine: engineRef.current } : {}) }, state)
    engineRef.current = next.engine as TensorFoldEngineFound | null
    if (alive.current) setFacts(next)
  }, [io])
  React.useEffect(() => {
    alive.current = true
    void read()
    return () => {
      alive.current = false
    }
  }, [read, version])
  React.useEffect(() => {
    const inFlight = facts !== null && Object.values(facts.acts).some(act => act.kind === 'pulling' || act.kind === 'starting' || act.kind === 'installing')
    if (!inFlight) return
    const timer = setInterval(() => void read(), TENSORFOLD_REFRESH_MS)
    return () => clearInterval(timer)
  }, [facts, read])
  React.useEffect(() => {
    if (repo !== undefined && repo !== '') void readOtherCheckpoint(repo, io.road)
  }, [repo, io.road])
  if (facts === null) return null
  const picker = standInRows(facts)
  const rowOf = (id: string): TensorFoldInventoryRow | undefined => facts.rows.find(row => modelIdOf(row) === id) ?? (facts.other?.read !== undefined && modelIdOf(facts.other.read) === id ? facts.other.read : undefined)
  const act = (what: TensorFoldPickerAct): void => void onTensorFoldAct(what, facts, io.road, { close: onDone, read: () => read(true) })
  const handleSelect = (id: string): void => {
    if (id === 'tensorfold:install') {
      act({ kind: 'install' })
      return
    }
    if (id === 'tensorfold:other') {
      setTensorFoldNotice(`/tensorfold owner/name reads a repository · ${W.otherReads}`)
      return
    }
    if (id === 'tensorfold:address') {
      setTensorFoldNotice('/tensorfold host:port adds a server on your network')
      return
    }
    if (id.startsWith('tensorfold:outside:')) {
      const port = Number(id.slice('tensorfold:outside:'.length))
      const server = facts.outside.find(candidate => candidate.port === port)
      if (server !== undefined) void switchOutside(server.name, server.port, io.road).then(words => setTensorFoldNotice(words))
      return
    }
    const row = rowOf(id)
    if (row === undefined) return
    const window = windowOf(row)
    if (row.state === 'serving' && window === row.window) {
      const served = facts.served.find(candidate => candidate.repo === row.repo)
      if (served !== undefined) void switchToTensorFold(served, io.road ?? {}).then(outcome => setTensorFoldNotice(outcome.words))
      return
    }
    act({ kind: 'serve', row, window })
  }
  const notice = tensorFoldRoadState().notice
  return (
    <MercuryModelPicker
      models={picker.models}
      headings={picker.headings}
      {...(picker.landing !== undefined ? { current: picker.landing } : {})}
      ctxPct={null}
      notice={notice ?? facts.live}
      onSelect={handleSelect}
      onClose={() => onDone(facts.live)}
    />
  )
}

export async function switchOutside(name: string, port: number, io: RoadIo = {}): Promise<string> {
  const root = `http://${servedAddress(port)}`
  const result = await pickAndProve(name, { ...io.prove, root, thinkingOff: true, env: discoveryEnvFor(root, io.prove?.env), ...(io.setAppState !== undefined ? { setAppState: io.setAppState } : {}) })
  return result.words
}

export async function onTensorFoldAct(act: TensorFoldPickerAct, facts: TensorFoldPanelFacts, io: RoadIo = {}, doors: { close?: (words?: string) => void; read?: () => Promise<void> } = {}): Promise<void> {
  const inventoryRow = (repo: string): TensorFoldInventoryRow | undefined => facts.rows.find(row => row.repo === repo) ?? (facts.other?.read?.repo === repo ? facts.other.read : undefined)
  switch (act.kind) {
    case 'install': {
      if (facts.install === null || (facts.install.kind !== 'brew' && facts.install.kind !== 'archive')) return
      const ok = await installTensorFoldThen(facts.install, io)
      if (ok) await doors.read?.()
      return
    }
    case 'serve': {
      const row = inventoryRow(act.row.repo)
      if (row === undefined) return
      if (row.state === 'serving') {
        const served = facts.served.find(candidate => candidate.repo === row.repo)
        if (served !== undefined) await stopTensorFoldRow(row, facts.served, { current: false }, io)
      }
      await serveTensorFoldRow({ ...row, state: row.state === 'serving' ? 'on-disk' : row.state }, act.window, io)
      return
    }
    case 'stop': {
      const row = inventoryRow(act.row.repo) ?? { repo: act.row.repo, shortName: act.row.shortName }
      const current = facts.current !== undefined && facts.current.endsWith(`/${act.row.shortName}`)
      setTensorFoldNotice(await stopTensorFoldRow(row, facts.served, { current }, io))
      return
    }
    case 'support': {
      const row = act.row === undefined ? undefined : inventoryRow(act.row.repo)
      setTensorFoldNotice(await copyTensorFoldSupportLine(io, act.host !== undefined ? { host: act.host.name } : supportFocusOf(row, act.window)))
      return
    }
    case 'limit':
      setTensorFoldNotice(await copyWiredLimitCommand(act.line, io))
      return
    case 'read':
      await readOtherCheckpoint(act.repo, io)
      return
    case 'address': {
      const address = act.address.trim()
      if (address === '') return
      try {
        rememberTensorFoldHost({ name: address.replace(/:\d+$/, ''), baseUrl: `http://${address}`, origin: 'typed' })
        setTensorFoldNotice(`${address} remembered · it appears under ${W.hostGroup} when it answers`)
      } catch (error) {
        setTensorFoldNotice(error instanceof Error ? error.message : String(error))
      }
      return
    }
    case 'rent':
      doors.close?.('/llmhost rents a GPU pod')
      return
    case 'app':
      setTensorFoldNotice(`the app is serving ${act.serving} · paste from its API tab · quit the app first to serve with Mercury instead`)
      return
    case 'share':
    case 'unshare': {
      const row = inventoryRow(act.row.repo)
      const served = facts.served.find(candidate => candidate.repo === act.row.repo)
      if (row === undefined || served === undefined) return
      setTensorFoldNotice(act.kind === 'share' ? SHARE_WORDS : UNSHARE_WORDS)
      await stopTensorFoldRow(row, facts.served, { current: false }, io)
      await serveTensorFoldRow({ ...row, state: 'on-disk', port: served.port }, served.window, io, { share: act.kind === 'share' })
      return
    }
  }
}

export function keepTensorFold(repo: string): void {
  keepTensorFoldRow(repo)
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  claimModelPickerPopup()
  const typed = args?.trim() ?? ''
  const io: TensorFoldPanelIo = { road: { ...(context.setAppState !== undefined ? { setAppState: context.setAppState } : {}) } }
  return (
    <ModelPickerPopupLease>
      <TensorFoldPanel onDone={words => onDone(words, { display: 'system' })} io={io} {...(typed !== '' ? { repo: typed } : {})} />
    </ModelPickerPopupLease>
  )
}
