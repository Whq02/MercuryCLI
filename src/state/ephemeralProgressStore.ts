// ephemeralProgressStore — the live tick projection for EPHEMERAL tool
// progress (bash_progress / powershell_progress / mcp_progress), QUICKSTEP
// finding 1.
//
// These frames would otherwise ride the transcript `messages` array (replace-last
// semantics), where they are NEVER a rendered row (the pipeline's first
// filter drops progress), never part of the API view, and never persisted —
// they existed there purely to feed two lookup maps. The cost: every 1s tick
// minted a new array identity, re-ran the whole normalize→filter→group→
// collapse→lookups pipeline (29–42ms at 27k messages) and re-rendered every
// mounted row to change nothing on screen.
//
// Here they live in a keyed external store instead: the REPL publishes a
// frame per parentToolUseID (replace semantics — only the latest tick
// matters), and exactly the rows/cards whose tool the frame belongs to
// subscribe. A tick re-renders ONE row's subtree; the transcript array, the
// pipeline memos and every other row keep their identity. The same shape as
// the streamingTail seam — a projection beside the transcript, never in it.
//
// Non-ephemeral progress (agent_progress / hook_progress / skill_progress)
// still accumulates in the transcript array — each frame carries distinct
// state the UI replays as a trail.

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ProgressMessage } from '../types/message.js'

const frames = new Map<string, ProgressMessage>()
const versions = new Map<string, number>()
const subscribers = new Map<string, Set<() => void>>()
/** Bumps on clear so version snapshots move for every subscriber. */
let epoch = 0

function notifyKey(key: string): void {
  const subs = subscribers.get(key)
  if (!subs) return
  for (const cb of subs) {
    try {
      cb()
    } catch {
      /* one throwing subscriber never blocks the rest */
    }
  }
}

/** Publish the latest ephemeral tick for its tool call (replace semantics). */
export function publishEphemeralProgress(msg: ProgressMessage): void {
  const key = msg.parentToolUseID
  frames.set(key, msg)
  versions.set(key, (versions.get(key) ?? 0) + 1)
  notifyKey(key)
}

/** Drop every frame — conversation resets (/clear, compaction, resume):
 *  the transcript array the frames annotate was rebuilt. */
export function clearEphemeralProgress(): void {
  if (frames.size === 0) return
  frames.clear()
  epoch++
  for (const key of [...subscribers.keys()]) notifyKey(key)
}

/** The latest frame for one tool call (identity-stable until replaced). */
export function getEphemeralProgressFrame(
  toolUseID: string,
): ProgressMessage | undefined {
  return frames.get(toolUseID)
}

/** Plain subscription (non-React consumers + provers). */
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

/** One row's live frame — re-renders exactly when ITS tool's tick moves. */
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

/** A grouped/collapsed card's re-render trigger over its member ids: the
 *  snapshot moves only when one of THESE tools' frames (or a clear) does. */
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

/** TEST-ONLY: reset module state between proof cases. */
export function _resetEphemeralProgressForTesting(): void {
  frames.clear()
  versions.clear()
  subscribers.clear()
  epoch = 0
}
