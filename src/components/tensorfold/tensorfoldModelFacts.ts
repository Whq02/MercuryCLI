import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { pickerFactsOf } from '../../commands/tensorfold/pickerFacts.js'
import { subscribeTensorFoldRoad, tensorFoldRoadState, tensorFoldRoadVersion } from '../../commands/tensorfold/road.js'
import { readTensorFoldPanelFacts, type FactsIo, type TensorFoldPanelFacts } from '../../commands/tensorfold/scene.js'
import { localServerProbingOff } from '../../services/localServer/localServerTruth.js'
import { getCachedLocalDiscovery } from '../../services/providers/local/localDiscovery.js'
import type { TensorFoldEngineFound } from '../../services/tensorfold/engine.js'
import { refreshTensorFoldAnnouncements, sameUrl, subscribeTensorFoldFacts, tensorFoldAnnouncementsNow, tensorFoldFactsStamp, tensorFoldHostsNow, withDiscoveredHosts } from './tensorfoldFacts.js'
import type { TensorFoldPickerFacts } from './tensorfoldRows.js'

const REFRESH_MS = 1_000

type ModelTensorFoldFacts = { panel: TensorFoldPanelFacts; picker: TensorFoldPickerFacts }

export type ModelTensorFold = {
  picker: TensorFoldPickerFacts
  panel: () => Promise<TensorFoldPanelFacts>
  read: (again?: boolean) => Promise<ModelTensorFoldFacts>
}

export async function readModelTensorFoldFacts(io: FactsIo = {}): Promise<ModelTensorFoldFacts> {
  const panel = await readTensorFoldPanelFacts(io, tensorFoldRoadState())
  const hosts = withDiscoveredHosts(panel.hosts)
  const own: TensorFoldPanelFacts = { ...panel, hosts, outside: panel.outside.filter(server => !hosts.some(host => sameUrl(host.baseUrl, server.baseUrl))) }
  return { panel: own, picker: pickerFactsOf(own) }
}

let last: ModelTensorFoldFacts | undefined

export function useModelTensorFoldFacts(current: string | undefined, onNotice: (words: string) => void): ModelTensorFold | undefined {
  const off = localServerProbingOff()
  const version = useSyncExternalStore(subscribeTensorFoldRoad, tensorFoldRoadVersion, tensorFoldRoadVersion)
  const stamp = useSyncExternalStore(subscribeTensorFoldFacts, tensorFoldFactsStamp, tensorFoldFactsStamp)
  const discovery = getCachedLocalDiscovery()
  const [facts, setFacts] = useState<ModelTensorFoldFacts | undefined>(last)
  const engine = useRef<TensorFoldEngineFound | null | undefined>(undefined)
  const reading = useRef<Promise<ModelTensorFoldFacts> | undefined>(undefined)
  const alive = useRef(true)
  const currentRef = useRef(current)
  currentRef.current = current
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice
  const read = useCallback((again = false): Promise<ModelTensorFoldFacts> => {
    if (again) engine.current = undefined
    const at = currentRef.current
    const next = readModelTensorFoldFacts({ ...(at !== undefined ? { current: at } : {}), ...(engine.current !== undefined ? { engine: engine.current } : {}) }).then(read => {
      engine.current = read.panel.engine as TensorFoldEngineFound | null
      last = read
      if (alive.current) setFacts(read)
      return read
    })
    reading.current = next
    return next
  }, [])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!off) void read().catch(() => undefined)
  }, [off, read, version, discovery])
  useEffect(() => {
    if (!off) void refreshTensorFoldAnnouncements()
  }, [off])
  const inFlight = facts !== undefined && Object.values(facts.panel.acts).some(act => act.kind === 'pulling' || act.kind === 'starting' || act.kind === 'installing')
  useEffect(() => {
    if (!inFlight) return
    const timer = setInterval(() => void read().catch(() => undefined), REFRESH_MS)
    return () => clearInterval(timer)
  }, [inFlight, read])
  const notice = useRef(tensorFoldRoadState().notice)
  useEffect(() => {
    const next = tensorFoldRoadState().notice
    if (next === notice.current) return
    notice.current = next
    if (next !== undefined) noticeRef.current(next)
  }, [version])
  const picker = useMemo((): TensorFoldPickerFacts => {
    void stamp
    const base = facts?.picker ?? { platform: process.platform, rows: [], hosts: tensorFoldHostsNow() }
    const announced = tensorFoldAnnouncementsNow(base.hosts ?? [])
    return announced.length > 0 ? { ...base, announced } : base
  }, [facts, stamp])
  if (off) return undefined
  return {
    picker,
    panel: async () => (facts ?? (await (reading.current ?? read()))).panel,
    read,
  }
}
