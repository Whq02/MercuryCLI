import { isProcessAlive } from './ownerWatch.js'

export const CLIENT_PRESENCE_BEAT_MS = 10_000
export const CLIENT_PRESENCE_STALE_MS = 3 * CLIENT_PRESENCE_BEAT_MS

export type ClientPresenceKind = 'screen' | 'client'

export function clientPresenceKindOf(raw: unknown): ClientPresenceKind | undefined {
  return raw === 'screen' || raw === 'client' ? raw : undefined
}
export type ClientPresenceVerdict = 'attached' | 'absent' | 'unknown'

export interface ClientPresenceRow {
  pid: number
  kind: ClientPresenceKind
  seenAt: number
}

const rows = new Map<number, ClientPresenceRow>()
let tableSince = Date.now()
let everNoted = false

export function noteClientPresence(pid: number, kind: ClientPresenceKind, now: number = Date.now()): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  rows.set(pid, { pid, kind, seenAt: now })
  everNoted = true
}

export function forgetClientPresence(pid: number): void {
  rows.delete(pid)
}

export function liveClients(now: number = Date.now(), alive: (pid: number) => boolean = isProcessAlive): ClientPresenceRow[] {
  const live: ClientPresenceRow[] = []
  for (const row of [...rows.values()]) {
    if (now - row.seenAt > CLIENT_PRESENCE_STALE_MS || !alive(row.pid)) {
      rows.delete(row.pid)
      continue
    }
    live.push(row)
  }
  return live
}

export function clientPresenceVerdict(now: number = Date.now(), alive: (pid: number) => boolean = isProcessAlive): ClientPresenceVerdict {
  if (liveClients(now, alive).length > 0) return 'attached'
  if (!everNoted && now - tableSince < CLIENT_PRESENCE_STALE_MS) return 'unknown'
  return 'absent'
}

export function resetClientPresenceForProofs(opts: { since?: number } = {}): void {
  rows.clear()
  everNoted = false
  tableSince = opts.since ?? Date.now()
}
