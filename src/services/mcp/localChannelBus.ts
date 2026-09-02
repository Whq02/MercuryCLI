/**
 * Local channel bus — Mercury's OWN inbound-channel transport.
 *
 * Hosted channels ride claude.ai/MCP: an MCP server emits a
 * `notifications/claude/channel` notification, the connection is gated by
 * `gateChannelServer` (firstParty provider + claude.ai OAuth + a remote
 * kill-switch + a managed-org opt-in), and that whole ingest path is folded
 * to `false` in the Mercury build
 * (true DCE). Net effect in the shipped product: channels are dead code, and
 * even the live code requires Anthropic-backend auth.
 *
 * This module re-grounds channels on a LOCAL transport instead, with NO auth and
 * NO MCP server required. It keeps the wire contract identical to the MCP path —
 * messages are wrapped with `wrapChannelMessage(...)` and pushed through the same
 * `enqueue(...)` with `origin: { kind: 'channel' }`, so `UserChannelMessage`
 * renders them and the model sees `<channel source="…">…</channel>` exactly as
 * before. Only the BACKEND SEAM is swapped: claude.ai/MCP → a file-backed inbox.
 *
 * THE BUS (functional, not a stub):
 *   <config home>/channels/<scope>/inbox.jsonl — append-only line-delimited bus.
 *   Each line is one JSON record: { server, content, meta? }. Any process
 *   (another Mercury session, an operator's script, a bridge daemon, a future
 *   chatroom relay) appends a line; THIS session tails new lines and enqueues
 *   them. `<scope>` defaults to `<cwd-basename>-<abspathhash8>` (a per-DIRECTORY
 *   room — the hash stops two unrelated dirs sharing a basename from colliding on
 *   one inbox; see getLocalChannelRoom) and can be overridden with
 *   MERCURY_CHANNEL_ROOM for a shared cross-project room — that is the foundation
 *   for the 2-operators-+-2-agents chatroom: every participant points
 *   MERCURY_CHANNEL_ROOM at the same name and posts into the one inbox.
 *
 * THE SEND HALF (`postLocalChannelMessage`): the symmetric writer. A teammate
 * (operator or agent) calls it — or appends a JSONL line by hand — to put a
 * message ON the bus for every tailing session. This is what makes the room
 * bidirectional and local.
 *
 * GATING: stamped-build only, and only when `isChannelsEnabled()` is true (which the
 * Mercury satisfies unconditionally — see channelAllowlist.ts). Hard
 * env override: MERCURY_LOCAL_CHANNELS=0 force-disables; =1 force-enables even off
 * a Mercury build. Never throws — a missing/locked/corrupt inbox degrades to no-op.
 */

import { resolveWatchRoot } from '../../utils/watchRoot.js'
import { watch } from 'fs'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from 'fs'
import { createHash } from 'crypto'
import { basename, join, resolve } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { channelsRoot } from './channelsRoot.js'
import { logForDebugging } from '../../utils/debug.js'
import { enqueue } from '../../utils/messageQueueManager.js'
import { isChannelsEnabled } from './channelAllowlist.js'
import { wrapChannelMessage } from './channelNotification.js'

/**
 * One line on the bus. `server` is the channel source (rendered as the
 * <channel source="…"> attribute and the transcript label); `meta` is the same
 * opaque {user, thread_id, …} passthrough the MCP path carries — projected onto
 * the tag by wrapChannelMessage (with the same SAFE_META_KEY filtering).
 */
export type LocalChannelRecord = {
  server: string
  content: string
  meta?: Record<string, string>
}

/**
 * Whether the local bus should run. Fork-build by default; MERCURY_LOCAL_CHANNELS
 * is the hard override (0 = off even on a fork, 1 = on even off a fork). Also
 * requires isChannelsEnabled() so the single channels kill-switch still works —
 * Mercury un-gates that in channelAllowlist.ts, so it's true here by default.
 */
export function isLocalChannelBusEnabled(): boolean {
  const env = flagEnv('MERCURY_LOCAL_CHANNELS')
  if (isEnvDefinedFalsy(env)) return false
  if (isEnvTruthy(env)) return true
  return isChannelsEnabled()
}

/**
 * Sanitize a raw room name to ONE safe path segment: strip anything outside
 * [a-zA-Z0-9._-] to '_', and neutralize a pure-dot result ('.', '..' — the
 * regex alone leaves those intact since '.' is in the allow-class) so the name
 * can never carry a path separator or a traversal op into getRoomDir()'s join.
 */
function sanitizeRoom(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_')
  return /^\.+$/.test(cleaned) ? 'default' : cleaned || 'default'
}

/**
 * Per-project room name. Default = the cwd basename PLUS a short hash of the
 * ABSOLUTE cwd path, e.g. `api-3f9a2b1c`. The bare basename alone was the
 * cross-session prompt-injection vector: two unrelated directories
 * that share a common basename ('api', 'src', 'app', 'server', 'web' …) mapped
 * to the SAME inbox, so a line written into one project's room was ingested as
 * an inbound `<channel>` message by an unrelated session in the other. Folding
 * a hash of the absolute path into the name keeps same-directory sessions
 * auto-joining (same abs path → same room) while giving distinct projects
 * distinct rooms, so an attacker must know the victim's exact absolute path to
 * target its inbox — not merely guess a common basename. `MERCURY_CHANNEL_ROOM`
 * overrides for an INTENTIONAL shared room (the operator chatroom) and is taken
 * verbatim (sanitized). The path is `resolve()`d so trailing-slash / '.' /
 * '..' variants of the same cwd collapse to one room.
 */
export function getLocalChannelRoom(): string {
  const override = flagEnv('MERCURY_CHANNEL_ROOM')?.trim()
  // SANITIZE the override too — not just the fallback — so a room name can never
  // contain a path separator or '..' that would escape channelsRoot().
  if (override) return sanitizeRoom(override)
  const cwd = resolve(getOriginalCwd() || process.cwd())
  const base = sanitizeRoom(basename(cwd) || 'default')
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

/** <channelsRoot>/<room>/ — created on demand. */
function getRoomDir(): string {
  return join(channelsRoot(), getLocalChannelRoom())
}

/** The append-only bus file for the active room. */
export function getLocalChannelInboxPath(): string {
  return join(getRoomDir(), 'inbox.jsonl')
}

function ensureRoomDir(): void {
  const dir = getRoomDir()
  // Owner-only (0700) so a channel room — which carries operator/agent chatter
  // the model ingests — is never world/group-readable or -writable on a shared
  // host.
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/**
 * SEND HALF — put a message ON the bus. Appends one JSON line to the room
 * inbox; every session tailing that room (including this one) will enqueue it.
 * Synchronous + atomic-enough for a line append; never throws (logs + returns
 * false on failure). This is the local analog of an MCP server calling
 * `send_message` then emitting the inbound notification — here the same write IS
 * the inbound event.
 */
export function postLocalChannelMessage(record: LocalChannelRecord): boolean {
  if (!record.server || typeof record.content !== 'string') return false
  try {
    ensureRoomDir()
    appendFileSync(
      getLocalChannelInboxPath(),
      `${JSON.stringify(record)}\n`,
      'utf8',
    )
    return true
  } catch (err) {
    logForDebugging(
      `[local-channel] post failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
}

/**
 * Push a single record into the conversation via the SAME path the MCP channel
 * handler uses: wrapChannelMessage → enqueue with origin {kind:'channel'},
 * isMeta, skipSlashCommands. Identical shape to useManageMCPConnections /
 * cli/print.ts so UserChannelMessage renders it and the model treats it as an
 * inbound channel message.
 */
function ingestRecord(record: LocalChannelRecord): void {
  if (!record.server || typeof record.content !== 'string') return
  enqueue({
    mode: 'prompt',
    value: wrapChannelMessage(record.server, record.content, record.meta),
    priority: 'next',
    isMeta: true,
    origin: { kind: 'channel', server: record.server },
    skipSlashCommands: true,
  })
}

/** Live tail handle — call stop() to tear down the watcher. */
export type LocalChannelBus = { stop: () => void }

/**
 * Start tailing the room inbox. Reads any EXISTING lines first (to a `from`
 * offset — default end-of-file so a fresh session does NOT replay history), then
 * watches the file and enqueues each newly-appended record. Returns a handle
 * whose stop() closes the watcher. No-op (returns a dead handle) when the bus is
 * disabled. Never throws.
 *
 * @param opts.replayHistory when true, ingest lines already in the file at
 *   startup (default false — only forward-looking messages, like joining a chat).
 */
export function startLocalChannelBus(
  opts: { replayHistory?: boolean } = {},
): LocalChannelBus {
  const dead: LocalChannelBus = { stop: () => {} }
  if (!isLocalChannelBusEnabled()) return dead

  let path: string
  try {
    ensureRoomDir()
    path = getLocalChannelInboxPath()
    // Touch the file so the watcher has something to watch.
    if (!existsSync(path)) appendFileSync(path, '', 'utf8')
  } catch (err) {
    logForDebugging(
      `[local-channel] init failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return dead
  }

  // Byte offset we've consumed up to. Start at EOF unless replaying history.
  let offset = 0
  try {
    offset = opts.replayHistory ? 0 : statSync(path).size
  } catch {
    offset = 0
  }
  // Carry a partial trailing line between reads (append may land mid-line).
  let carry = ''

  const drainFrom = (): void => {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return
    }
    if (size < offset) {
      // File was truncated/rotated — restart from the top.
      offset = 0
      carry = ''
    }
    if (size === offset) return
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch {
      return
    }
    try {
      const len = size - offset
      const buf = Buffer.allocUnsafe(len)
      const read = readSync(fd, buf, 0, len, offset)
      offset += read
      const chunk = carry + buf.toString('utf8', 0, read)
      const lines = chunk.split('\n')
      // Last element is the (possibly partial) trailing line — carry it.
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let record: LocalChannelRecord
        try {
          record = JSON.parse(trimmed) as LocalChannelRecord
        } catch {
          logForDebugging(`[local-channel] skipping malformed line: ${trimmed.slice(0, 80)}`)
          continue
        }
        ingestRecord(record)
      }
    } finally {
      closeSync(fd)
    }
  }

  // Initial drain (history replay, or nothing when starting at EOF).
  drainFrom()

  let watcher: ReturnType<typeof watch> | null = null
  try {
    watcher = watch(resolveWatchRoot(path), { persistent: false }, () => drainFrom())
    //  follow-on: own the 'error' event; the 1s poll floor is
    // the delivery guarantee — a dead watcher only costs latency.
    watcher.on('error', e => logForDebugging(`[localChannelBus] watcher error: ${e}`))
  } catch (err) {
    logForDebugging(
      `[local-channel] watch failed (polling fallback): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Polling fallback/safety net — fs.watch misses some appends on certain
  // filesystems (network mounts, some editors). A light 1s poll guarantees
  // delivery without depending on inotify semantics.
  const poll = setInterval(drainFrom, 1000)
  if (typeof poll.unref === 'function') poll.unref()

  logForDebugging(
    `[local-channel] bus live · room=${getLocalChannelRoom()} · inbox=${path}`,
  )

  return {
    stop: () => {
      try {
        watcher?.close()
      } catch {
        /* ignore */
      }
      clearInterval(poll)
    },
  }
}
