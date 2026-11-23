import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useClaim, useLoad, usePublish } from '../effects/effects.js'
import { pickerFactsOf } from '../../commands/tensorfold/pickerFacts.js'
import { subscribeTensorFoldPods, subscribeTensorFoldRoad, tensorFoldRoadState, tensorFoldRoadVersion } from '../../commands/tensorfold/road.js'
import { readTensorFoldPanelFacts, type FactsIo, type TensorFoldPanelFacts } from '../../commands/tensorfold/scene.js'
import { localServerProbingOff } from '../../models/local-server/localServerTruth.js'
import { getCachedLocalDiscovery } from '../../models/roads/local/localDiscovery.js'
import type { TensorFoldEngineFound } from '../../models/tensorfold/engine.js'
import { refreshTensorFoldAnnouncements, subscribeTensorFoldFacts, tensorFoldAnnouncementsNow, tensorFoldFactsStamp, tensorFoldHostsNow } from './tensorfoldFacts.js'
import type { TensorFoldPickerFacts } from './tensorfoldRows.js'
import { passedOverAs } from '../../platform/errors/passedOver.js'
type ModelTensorFoldFacts = { panel: TensorFoldPanelFacts; picker: TensorFoldPickerFacts }

export type ModelTensorFold = {
  picker: TensorFoldPickerFacts
  panel: () => Promise<TensorFoldPanelFacts>
  read: (again?: boolean) => Promise<ModelTensorFoldFacts>
}

export async function readModelTensorFoldFacts(io: FactsIo = {}): Promise<ModelTensorFoldFacts> {
  const panel = await readTensorFoldPanelFacts(io, tensorFoldRoadState())
  return { panel, picker: pickerFactsOf(panel) }
}

let factsSnapshot: ModelTensorFoldFacts | undefined

export function useModelTensorFoldFacts(current: string | undefined, onNotice: (words: string) => void): ModelTensorFold | undefined {
  const off = localServerProbingOff()
  const version = useSyncExternalStore(subscribeTensorFoldRoad, tensorFoldRoadVersion, tensorFoldRoadVersion)
  const stamp = useSyncExternalStore(subscribeTensorFoldFacts, tensorFoldFactsStamp, tensorFoldFactsStamp)
  const discovery = getCachedLocalDiscovery()
  const [facts, setFacts] = useState<ModelTensorFoldFacts | undefined>(factsSnapshot)
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
      factsSnapshot = read
      if (alive.current) setFacts(read)
      return read
    })
    reading.current = next
    return next
  }, [])
  useClaim(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useLoad(() => {
    if (!off) void read().catch(passedOverAs(undefined))
  }, [off, read, version, discovery])
  useLoad(() => {
    if (!off) void refreshTensorFoldAnnouncements()
  }, [off])
  const podStarting = facts !== undefined && facts.panel.pods.some(pod => pod.state === 'starting')
  const podStopping = facts !== undefined && facts.panel.pods.some(pod => pod.state === 'stopping')
  useClaim(() => {
    if (off || (!podStarting && !podStopping)) return
    return subscribeTensorFoldPods(podStopping, () => { void read().catch(passedOverAs(undefined)) })
  }, [off, podStarting, podStopping, read])
  const notice = useRef(tensorFoldRoadState().notice)
  usePublish(() => {
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
