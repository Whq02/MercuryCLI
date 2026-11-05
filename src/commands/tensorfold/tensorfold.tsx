import * as React from 'react'
import { MercuryModelPicker } from '../../components/MercuryModelPicker.js'
import { ModelPickerPopupLease } from '../../components/ModelPickerPopupSlot.js'
import { focusedSessionModelFacts } from '../../services/engine-connector/focusedConnector.js'
import { modelDoorRoad } from '../../services/host/door.js'
import { runHostedModel } from '../../services/host/index.js'
import { stopTensorFoldPod, terminateTensorFoldPod } from '../../services/host/tensorfoldPod.js'
import { resolveSetupIo } from '../../services/localSetup/setupIo.js'
import { pickAndProve, switchSessionModel } from '../../services/localSetup/setupProve.js'
import { PAIRING_WORDS } from '../../services/lan/pairing.js'
import { forgetTensorFoldHost, rememberTensorFoldHost, rememberTensorFoldPort, tensorFoldHosts } from '../../services/providers/local/tensorfoldHosts.js'
import type { TensorFoldHost } from '../../services/tensorfold/contracts.js'
import type { TensorFoldEngineFound } from '../../services/tensorfold/engine.js'
import type { TensorFoldInventoryRow } from '../../services/tensorfold/inventory.js'
import { tensorFoldPairingCode } from '../../services/tensorfold/serve.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { claimModelPickerPopup } from '../../utils/cockpit/modelPickerPopup.js'
import { openSettingsPopup } from '../../utils/cockpit/settingsPopup.js'
import { getEngineModel } from '../../utils/model/model.js'
import { llmHostPopupRequest } from '../llmhost/llmhost.js'
import { pairTensorFoldHost, refreshTensorFoldAnnouncements, subscribeTensorFoldFacts, tensorFoldAnnouncementsNow, tensorFoldFactsStamp } from '../../components/tensorfold/tensorfoldFacts.js'
import { pickerFactsOf, type TensorFoldPickerAct } from './pickerFacts.js'
import {
  SHARE_WORDS,
  UNSHARE_WORDS,
  copyTensorFoldSupportLine,
  copyWiredLimitCommand,
  discoveryEnvFor,
  installTensorFoldThen,
  readOtherCheckpoint,
  serveTensorFoldRow,
  setTensorFoldNotice,
  stopTensorFoldRow,
  subscribeTensorFoldRoad,
  supportFocusOf,
  switchToTensorFold,
  tensorFoldRoadState,
  tensorFoldRoadVersion,
  type RoadIo,
} from './road.js'
import { loopbackPortOf, readTensorFoldPanelFacts, servedAddress, type FactsIo, type TensorFoldPanelFacts } from './scene.js'
import { refreshLocalDiscovery } from '../../services/providers/local/localDiscovery.js'
import { localServerProbingOff } from '../../services/localServer/localServerTruth.js'
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
  const announcedStamp = React.useSyncExternalStore(subscribeTensorFoldFacts, tensorFoldFactsStamp, tensorFoldFactsStamp)
  React.useEffect(() => {
    void refreshTensorFoldAnnouncements()
  }, [])
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
    const inFlight = facts !== null && (Object.values(facts.acts).some(act => act.kind === 'pulling' || act.kind === 'starting' || act.kind === 'installing') || facts.pods.some(pod => pod.state === 'starting' || pod.state === 'stopping'))
    if (!inFlight) return
    const timer = setInterval(() => void read(), TENSORFOLD_REFRESH_MS)
    return () => clearInterval(timer)
  }, [facts, read])
  React.useEffect(() => {
    if (repo !== undefined && repo !== '') void readOtherCheckpoint(repo, io.road)
  }, [repo, io.road])
  const picker = React.useMemo(() => (facts === null ? null : { ...pickerFactsOf(facts), announced: tensorFoldAnnouncementsNow(facts.hosts) }), [facts, announcedStamp])
  if (facts === null || picker === null) return null
  const doors = { close: onDone, read: () => read(true) }
  const notice = tensorFoldRoadState().notice
  return (
    <MercuryModelPicker
      view="tensorfold"
      live={facts.live}
      models={[]}
      current={facts.current ?? ''}
      ctxPct={null}
      tensorfold={picker}
      {...(notice !== undefined ? { notice } : {})}
      onTensorFold={act => void onTensorFoldAct(act, facts, io.road, doors)}
      onSelect={id => void switchTensorFoldId(id, facts, io.road).then(words => setTensorFoldNotice(words))}
      onClose={() => onDone(facts.live)}
    />
  )
}

export async function switchOutside(name: string, port: number, io: RoadIo = {}): Promise<string> {
  return switchAt(name, `http://${servedAddress(port)}`, io)
}

async function switchAt(name: string, root: string, io: RoadIo): Promise<string> {
  const result = await pickAndProve(name, { ...io.prove, root, thinkingOff: true, env: discoveryEnvFor(root, io.prove?.env), ...(io.setAppState !== undefined ? { setAppState: io.setAppState } : {}) })
  return result.words
}

async function switchPod(id: string, io: RoadIo): Promise<string> {
  const setup = resolveSetupIo({ ...io.prove, ...(io.setAppState !== undefined ? { setAppState: io.setAppState } : {}) })
  const switched = await switchSessionModel(id, setup)
  if (switched.settled === 'refused') return switched.settledDetail ?? `${id} was not switched`
  return `${id} is this session's model${setup.persist(id).sentence}`
}

export async function switchTensorFoldId(id: string, facts: TensorFoldPanelFacts, io: RoadIo = {}): Promise<string> {
  if (id.startsWith('compat/')) return switchPod(id, io)
  const name = id.startsWith('local/') ? id.slice('local/'.length) : id
  const served = facts.served.find(candidate => candidate.name === name || candidate.repo === name)
  if (served !== undefined) return (await switchToTensorFold(served, io)).words
  const outside = facts.outside.find(server => server.name === name)
  if (outside !== undefined) return switchOutside(outside.name, outside.port, io)
  const host: TensorFoldHost | undefined = facts.hosts.find(candidate => candidate.serving === name)
  if (host !== undefined) return switchAt(name, host.baseUrl, io)
  return `${name} is not served · ↵ on its row serves it`
}

export async function onTensorFoldAct(act: TensorFoldPickerAct, facts: TensorFoldPanelFacts, io: RoadIo = {}, doors: { close?: (words?: string) => void; read?: () => Promise<void> } = {}): Promise<void> {
  const inventoryRow = (repo: string): TensorFoldInventoryRow | undefined => facts.rows.find(row => row.repo === repo) ?? (facts.other?.read?.repo === repo ? facts.other.read : undefined)
  switch (act.kind) {
    case 'install': {
      if (facts.install === null || (facts.install.kind !== 'brew' && facts.install.kind !== 'archive' && facts.install.kind !== 'llamacpp')) return
      const ok = await installTensorFoldThen(facts.install, io)
      if (ok) await doors.read?.()
      return
    }
    case 'serve': {
      const row = inventoryRow(act.row.repo)
      if (row === undefined) return
      if (facts.engine === null || facts.install?.kind === 'llamacpp') {
        if (facts.install === null || (facts.install.kind !== 'brew' && facts.install.kind !== 'archive' && facts.install.kind !== 'llamacpp')) return
        const installed = await installTensorFoldThen(facts.install, io)
        await doors.read?.()
        if (!installed) return
      }
      if (row.state === 'serving') {
        const served = facts.served.find(candidate => candidate.repo === row.repo)
        if (served !== undefined) await stopTensorFoldRow(row, facts.served, io)
      }
      await serveTensorFoldRow({ ...row, state: row.state === 'serving' ? 'on-disk' : row.state }, act.window, io, { ...(facts.engine?.servedBy !== undefined ? { servedBy: facts.engine.servedBy } : {}) })
      return
    }
    case 'switch':
      setTensorFoldNotice(await switchTensorFoldId(act.id, facts, io))
      return
    case 'stop': {
      const row = inventoryRow(act.row.repo) ?? { repo: act.row.repo, shortName: act.row.shortName }
      setTensorFoldNotice(await stopTensorFoldRow(row, facts.served, io))
      return
    }
    case 'stop-pod': {
      setTensorFoldNotice(`stopping ${act.name}`)
      setTensorFoldNotice((await (io.stopPod ?? stopTensorFoldPod)(act.id)).words)
      await doors.read?.()
      return
    }
    case 'terminate-pod': {
      setTensorFoldNotice(`terminating ${act.name}`)
      setTensorFoldNotice((await (io.terminatePod ?? terminateTensorFoldPod)(act.id)).words)
      await doors.read?.()
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
    case 'pair': {
      const words = await pairTensorFoldHost(act.host, act.code)
      if (words !== undefined) setTensorFoldNotice(words)
      await doors.read?.()
      return
    }
    case 'address': {
      const address = act.address.trim().replace(/^[a-z]+:\/\//i, '')
      if (address === '') return
      try {
        const here = /^(?:localhost|127(?:\.\d+){3}|\[::1\]|::1)(?::(\d+))?$/i.exec(address)
        if (here !== null) {
          const port = here[1] === undefined ? 8080 : Number(here[1])
          rememberTensorFoldPort(port)
          for (const host of tensorFoldHosts().filter(host => host.origin === 'typed' && loopbackPortOf(host.baseUrl) === port)) await forgetTensorFoldHost(host.name)
          setTensorFoldNotice(`${address} remembered · a server on this machine appears under ${W.group} when it answers`)
        } else {
          await rememberTensorFoldHost({ name: address.replace(/:\d+$/, ''), baseUrl: `http://${address}`, origin: 'typed' })
          setTensorFoldNotice(`${address} remembered · it appears under ${W.hostGroup} when it answers`)
        }
        if (!localServerProbingOff()) await refreshLocalDiscovery({ force: true }).catch(() => undefined)
        await doors.read?.()
      } catch (error) {
        setTensorFoldNotice(error instanceof Error ? error.message : String(error))
      }
      return
    }
    case 'rent':
      doors.close?.('/llmhost rents a GPU pod')
      openSettingsPopup(llmHostPopupRequest(facts.rent !== undefined ? modelDoorRoad(runHostedModel, facts.rent.title) : undefined))
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
      await stopTensorFoldRow(row, facts.served, io)
      const outcome = await serveTensorFoldRow({ ...row, state: 'on-disk', port: served.port }, served.window, io, { share: act.kind === 'share' })
      const code = tensorFoldPairingCode()
      if (act.kind === 'share' && outcome !== null && code !== null) setTensorFoldNotice(PAIRING_WORDS.shown(code, outcome.served.name))
      return
    }
  }
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
