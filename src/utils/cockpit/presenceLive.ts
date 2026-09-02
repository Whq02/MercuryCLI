// ============================================================================
import { flagEnv } from '../../substrate/flagRegistry.js'
import { fluxMark } from '../flux/fluxProbe.js'
//  presenceLive — the multiplayer-presence primitive (A1 spike, Task 1).
//
//  Each session PUBLISHES its own presence (what verb · which branch · last line)
//  to a shared room and TAILS the other seats' presence, so the deck can show
//  "watch your friend work". This is the producer + tailer + a render-published
//  sync store (mirrors contextUsageLive.ts's publish/subscribe shape so the
//  persistent DeckPane repaints without threading state through the React-Compiler
//  FullscreenLayout).
//
//  THE INVARIANT (non-negotiable): presence is AGENT-IGNORED BY CONSTRUCTION.
//  It lives in a SEPARATE per-seat snapshot file — <config home>/channels/<room>/
//  presence/<seat>.json — and NEVER goes through the channel-bus ingest path. A
//  channel inbox.jsonl record is wrapped as "decide whether to respond" and
//  becomes a model turn; presence must NEVER touch that. So this module imports NO
//  enqueue / ingestRecord and writes NOTHING to inbox.jsonl — only its own
//  per-seat JSON snapshots. (A Task-4 proof locks this; scripts/ui/prove-presence-
//  live.ts greps for it too.)
//
//  ROOM RESOLUTION: the SAME <channelsRoot>/<room>/ the local channel bus
//  uses, with a new `presence/` subdir. The ROOT is imported from the shared
//  channelsRoot.ts owner (tiny, `bun run`-loadable — unlike the bus module,
//  which statically pulls messageQueueManager → the bun:bundle feature() macro
//  + color-diff-napi). Only the ROOM-NAME assembly (the path-hashed
//  default + the sanitized MERCURY_CHANNEL_ROOM override) is still mirrored
//  from getLocalChannelRoom, for the same loadability reason. The GATE
//  decision is driven by the SAME shared primitives the bus uses
//  (isChannelsEnabled() + the MERCURY_LOCAL_CHANNELS override), so presence and
//  the bus agree on which room is active by construction. A behavioural twin
//  of the room assembly is also asserted in the channels proof.
//
//  GATING: active only when the local bus would be (
//  isChannelsEnabled(), or MERCURY_LOCAL_CHANNELS=1) OR an explicit
//  MERCURY_CHANNEL_ROOM is set (the intentional shared room that multiplayer
//  presence always implies). No room ⇒ every entry point degrades to a clean
//  no-op; nothing here ever throws.
// ============================================================================

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import os from 'node:os'
import { basename, join, resolve } from 'path'
import { createHash } from 'crypto'
import { durableTempName } from '../../substrate/durablePublish.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { isChannelsEnabled } from '../../services/mcp/channelAllowlist.js'
import { channelsRoot } from '../../services/mcp/channelsRoot.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'

/**
 * One seat's live presence. `seat` is the operator identity (MERCURY_OPERATOR,
 * else the OS username — the SAME getOperatorName() /say uses); `verb` is the
 * coarse activity ("editing", "reviewing"); `branch` the git branch; `lastLine` a
 * short human breadcrumb; `ts` the publish time (epoch ms, stamped on write).
 */
export type PresenceSeat = {
  seat: string
  verb: string
  branch: string
  lastLine: string
  ts: number
}

/** Peers older than this (ms) are treated as gone and dropped on the next tail. */
export const STALE_MS = 10_000

// ── module-state sync store (mirrors contextUsageLive's publish/subscribe) ────
let _presence = new Map<string, PresenceSeat>()
let _version = 0
const _subscribers = new Set<() => void>()

/**
 * Seat identity — REPLICATES say/index.ts's private getOperatorName() (there is no
 * shared export; /say keeps its own copy too). MERCURY_OPERATOR names you, else the
 * OS username, else "operator". Used to EXCLUDE the local seat from the tail.
 *
 * Exported so the lifecycle wiring (useManageMCPConnections) publishes under the
 * EXACT same seat id the tailer self-excludes on — one source of truth for "who
 * am I in this room", no drift between producer and tailer.
 */
export function getOperatorName(): string {
  const env = flagEnv('MERCURY_OPERATOR')?.trim()
  if (env) return env
  try {
    return os.userInfo().username || 'operator'
  } catch {
    return 'operator'
  }
}

/**
 * Sanitize a raw name to ONE safe path segment — MIRRORS localChannelBus's
 * sanitizeRoom: strip anything outside [a-zA-Z0-9._-] to '_', and neutralize a
 * pure-dot result ('.', '..') so the name can never carry a separator or a
 * traversal op into the join. Reused for both the room override and seat
 * filenames.
 */
function sanitizeSegment(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_')
  return /^\.+$/.test(cleaned) ? 'default' : cleaned || 'default'
}

/**
 * The active room name — MIRRORS localChannelBus.getLocalChannelRoom: a sanitized
 * MERCURY_CHANNEL_ROOM override, else the cwd basename + an 8-hex hash of the
 * absolute cwd.
 */
function channelRoom(): string {
  const override = flagEnv('MERCURY_CHANNEL_ROOM')?.trim()
  if (override) return sanitizeSegment(override)
  const cwd = resolve(getOriginalCwd() || process.cwd())
  const base = sanitizeSegment(basename(cwd) || 'default')
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

/**
 * Whether presence should run. The SAME gate as the local bus
 * (isChannelsEnabled(), MERCURY_LOCAL_CHANNELS overrides),
 * OR an explicit MERCURY_CHANNEL_ROOM — which multiplayer presence always implies.
 */
function presenceActive(): boolean {
  if (flagEnv('MERCURY_CHANNEL_ROOM')?.trim()) return true
  const env = flagEnv('MERCURY_LOCAL_CHANNELS')
  if (isEnvDefinedFalsy(env)) return false
  if (isEnvTruthy(env)) return true
  return isChannelsEnabled()
}

/** <channelsRoot>/<room>/presence/ — the per-seat snapshot dir. */
function presenceDirPath(): string {
  return join(channelsRoot(), channelRoom(), 'presence')
}

/**
 * The active presence dir, or null when no room is active. Exposed so the deck
 * (and the invariant proof) can locate the per-seat snapshots WITHOUT importing
 * the heavy bus module — and so callers can see at a glance that presence writes
 * land in `presence/`, never in the sibling `inbox.jsonl`.
 */
export function getPresenceDir(): string | null {
  if (!presenceActive()) return null
  try {
    return presenceDirPath()
  } catch {
    return null
  }
}

/**
 * PRODUCER — publish THIS seat's presence (last-write-wins). Writes
 * presence/<seat>.json ATOMICALLY: a unique tmp file in the same dir, then
 * rename, so a concurrent tailer never reads a half-written record. No-op when no
 * room is active; never throws.
 */
export function recordSelfPresence(p: Omit<PresenceSeat, 'ts'>): void {
  if (!presenceActive()) return
  let dir: string
  try {
    dir = presenceDirPath()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (err) {
    logForDebugging(
      `[presence] dir init failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }
  const rec: PresenceSeat = {
    seat: p.seat,
    verb: p.verb,
    branch: p.branch,
    lastLine: p.lastLine,
    ts: Date.now(),
  }
  const stem = sanitizeSegment(p.seat)
  const finalPath = join(dir, `${stem}.json`)
  // Unique tmp in the SAME dir so the rename is atomic (same filesystem) and two
  // concurrent self-writes can't clobber each other's tmp file mid-flight.
  // The name is the durable owner's pattern so a crash's orphan is
  // collected by the age-gated sweeps; the write itself DELIBERATELY stays
  // outside durableAtomicPublishSync: presence is ephemeral ts-gated state on
  // the UI thread — the 3s heartbeat IS the retry (a win32 transient lock
  // costs one beat, never a 350ms render stall) and fsync would buy nothing
  // a reboot doesn't erase anyway.
  const tmpPath = durableTempName(finalPath)
  try {
    writeFileSync(tmpPath, JSON.stringify(rec), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, finalPath)
  } catch (err) {
    logForDebugging(
      `[presence] write failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath)
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * TAILER — refresh the live set from every presence/*.json in the active room,
 * EXCLUDING the local seat (getOperatorName()) and DROPPING entries older than
 * STALE_MS. Rebuilds the Map from scratch each call (so a vanished/stale peer
 * disappears). Output-edge dedupe: the version bump + subscriber
 * notify fire ONLY when the rebuilt set actually differs from the live one —
 * the zero-peer steady state (every solo session, forever) must not
 * committed a full React render every 2s tail for identical data (the same
 * unchanged-tick-bails discipline uiClock and the frame chip's sig-dedupe
 * already follow). A peer's heartbeat refreshes its `ts`, so live peers still
 * notify on every publish; a stale-drop changes the set, so departures
 * notify too. No-op yielding an empty set when no room is active; never
 * throws.
 */
export function tailPresence(): void {
  const self = getOperatorName()
  const now = Date.now()
  const next = new Map<string, PresenceSeat>()
  const dir = getPresenceDir()
  if (dir) {
    let files: string[] = []
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.json'))
    } catch {
      files = [] // dir not created yet ⇒ no peers
    }
    for (const f of files) {
      let rec: Partial<PresenceSeat>
      try {
        rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Partial<PresenceSeat>
      } catch {
        continue // malformed or mid-write — skip, pick it up next tail
      }
      if (!rec || typeof rec.seat !== 'string' || typeof rec.ts !== 'number') continue
      if (rec.seat === self) continue // self-exclusion (the invariant's render half)
      if (now - rec.ts > STALE_MS) continue // stale-drop
      next.set(rec.seat, {
        seat: rec.seat,
        verb: typeof rec.verb === 'string' ? rec.verb : '',
        branch: typeof rec.branch === 'string' ? rec.branch : '',
        lastLine: typeof rec.lastLine === 'string' ? rec.lastLine : '',
        ts: rec.ts,
      })
    }
  }
  const changed =
    next.size !== _presence.size ||
    [...next].some(([seat, v]) => {
      const prev = _presence.get(seat)
      return (
        !prev ||
        prev.verb !== v.verb ||
        prev.branch !== v.branch ||
        prev.lastLine !== v.lastLine ||
        prev.ts !== v.ts
      )
    })
  if (!changed) return
  _presence = next
  _version++
  fluxMark('presence:publish') // probe-gated ring stamp (off ⇒ no-op)
  for (const cb of [..._subscribers]) {
    try {
      cb()
    } catch {
      /* a bad subscriber never breaks the tail */
    }
  }
}

/** Sync read of the live peer set (for render). Sorted by seat for stable order. */
export function getLivePresence(): PresenceSeat[] {
  return [..._presence.values()].sort((a, b) => a.seat.localeCompare(b.seat))
}

/**
 * Subscribe to live-presence changes (deck repaint). Returns an unsubscribe fn.
 * Pair with getPresenceVersion() as the getSnapshot for useSyncExternalStore.
 */
export function subscribePresence(cb: () => void): () => void {
  _subscribers.add(cb)
  return () => {
    _subscribers.delete(cb)
  }
}

/** Monotonic version counter — bumps on every CHANGED tail so React can detect a change. */
export function getPresenceVersion(): number {
  return _version
}
