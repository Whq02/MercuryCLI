
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ProgressMessage } from '../types/message.js'

const frames = new Map<string, ProgressMessage>()
const versions = new Map<string, number>()
const subscribers = new Map<string, Set<() => void>>()
let epoch = 0

function notifyKey(key: string): void {
  const subs = subscribers.get(key)
  if (!subs) return
  for (const cb of subs) {
    try {
      cb()
    } catch {
    }
  }
}

export function publishEphemeralProgress(msg: ProgressMessage): void {
  const key = msg.parentToolUseID
  frames.set(key, msg)
  versions.set(key, (versions.get(key) ?? 0) + 1)
  notifyKey(key)
}

export function clearEphemeralProgress(): void {
  if (frames.size === 0) return
  frames.clear()
  epoch++
  for (const key of [...subscribers.keys()]) notifyKey(key)
}

export function getEphemeralProgressFrame(
  toolUseID: string,
): ProgressMessage | undefined {
  return frames.get(toolUseID)
}

export function subscribeEphemeralProgress(
  toolUseID: string,
  cb: () => void,
): () => void {
  return subscribeKey(toolUseID, cb)
}

function subscribeKey(key: string, cb: () => void): () => void {
  let set = subscribers.get(key)
  if (!set) {
    set = new Set()
    subscribers.set(key, set)
  }
  set.add(cb)
  return () => {
    set.delete(cb)
    if (set.size === 0) subscribers.delete(key)
  }
}

export function useEphemeralProgress(
  toolUseID: string | undefined,
): ProgressMessage | undefined {
  const subscribe = useCallback(
    (cb: () => void) =>
      toolUseID === undefined ? () => {} : subscribeKey(toolUseID, cb),
    [toolUseID],
  )
  const get = useCallback(
    () => (toolUseID === undefined ? undefined : frames.get(toolUseID)),
    [toolUseID],
  )
  return useSyncExternalStore(subscribe, get, get)
}

export function useEphemeralProgressVersion(
  toolUseIDs: readonly string[],
): number {
  const key = useMemo(() => toolUseIDs.join('\u0000'), [toolUseIDs])
  const ids = useMemo(() => (key === '' ? [] : key.split('\u0000')), [key])
  const subscribe = useCallback(
    (cb: () => void) => {
      const unsubs = ids.map(id => subscribeKey(id, cb))
      return () => {
        for (const u of unsubs) u()
      }
    },
    [ids],
  )
  const get = useCallback(
    () => ids.reduce((acc, id) => acc + (versions.get(id) ?? 0), epoch),
    [ids],
  )
  return useSyncExternalStore(subscribe, get, get)
}

export function _resetEphemeralProgressForTesting(): void {
  frames.clear()
  versions.clear()
  subscribers.clear()
  epoch = 0
}
