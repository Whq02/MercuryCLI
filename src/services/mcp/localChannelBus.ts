
import { resolveWatchRoot } from '../../utils/watchRoot.js'
import { subscribeUiClock } from '../../utils/cockpit/uiClock.js'
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

export type LocalChannelRecord = {
  server: string
  content: string
  meta?: Record<string, string>
}

export function isLocalChannelBusEnabled(): boolean {
  const env = flagEnv('MERCURY_LOCAL_CHANNELS')
  if (isEnvDefinedFalsy(env)) return false
  if (isEnvTruthy(env)) return true
  return isChannelsEnabled()
}

function sanitizeRoom(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_')
  return /^\.+$/.test(cleaned) ? 'default' : cleaned || 'default'
}

export function getLocalChannelRoom(): string {
  const override = flagEnv('MERCURY_CHANNEL_ROOM')?.trim()
  if (override) return sanitizeRoom(override)
  const cwd = resolve(getOriginalCwd() || process.cwd())
  const base = sanitizeRoom(basename(cwd) || 'default')
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

function getRoomDir(): string {
  return join(channelsRoot(), getLocalChannelRoom())
}

export function getLocalChannelInboxPath(): string {
  return join(getRoomDir(), 'inbox.jsonl')
}

function ensureRoomDir(): void {
  const dir = getRoomDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

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

export type LocalChannelBus = { stop: () => void }

export function startLocalChannelBus(
  opts: { replayHistory?: boolean } = {},
): LocalChannelBus {
  const dead: LocalChannelBus = { stop: () => {} }
  if (!isLocalChannelBusEnabled()) return dead

  let path: string
  try {
    ensureRoomDir()
    path = getLocalChannelInboxPath()
    if (!existsSync(path)) appendFileSync(path, '', 'utf8')
  } catch (err) {
    logForDebugging(
      `[local-channel] init failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return dead
  }

  let offset = 0
  try {
    offset = opts.replayHistory ? 0 : statSync(path).size
  } catch {
    offset = 0
  }
  let carry = ''

  const drainFrom = (): void => {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return
    }
    if (size < offset) {
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

  drainFrom()

  let watcher: ReturnType<typeof watch> | null = null
  try {
    watcher = watch(resolveWatchRoot(path), { persistent: false }, () => drainFrom())
    watcher.on('error', e => logForDebugging(`[localChannelBus] watcher error: ${e}`))
  } catch (err) {
    logForDebugging(
      `[local-channel] watch failed (polling fallback): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const stopPoll = subscribeUiClock(1000, drainFrom)

  logForDebugging(
    `[local-channel] bus live · room=${getLocalChannelRoom()} · inbox=${path}`,
  )

  return {
    stop: () => {
      try {
        watcher?.close()
      } catch {
      }
      stopPoll()
    },
  }
}
