import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishAtomicSync } from '../../substrate/fileStore.js'
import { enqueuePendingNotification, subscribeQueueConsumption } from '../../input-core/command-queue.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { escapeXml } from '../../utils/xml.js'
import { hostDirectory, type HostRecord } from './store.js'

export function hostNotice(record: HostRecord, kind: string, words: string): void {
  if (!record.sessionId) return
  const dir = join(hostDirectory(), 'notices')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const id = createHash('sha256').update([record.id, record.generation, kind].join(':')).digest('hex')
  const path = join(dir, id + '.json')
  const status = kind === 'failed' ? 'failed' : kind === 'ended' || kind === 'expired' || kind === 'paused' || kind === 'idle' ? 'stopped' : 'completed'
  const notice = '<task-notification>\n<task-id>host-' + id + '</task-id>\n<status>' + status + '</status>\n<summary>' + escapeXml(words.split('\n')[0] ?? words) + '</summary>\n<result>' + escapeXml(words) + '</result>\n</task-notification>'
  if (!existsSync(path)) publishAtomicSync(path, JSON.stringify({ id, sessionId: record.sessionId, words: notice }), { mode: 0o600 })
}
const queuedNotices = new Map<string, string>()
const damagedNotices = new Set<string>()
let observingConsumption = false

export function deliverHostNotices(sessionId: string): void {
  if (!observingConsumption) {
    subscribeQueueConsumption(event => {
      for (const command of event.commands) {
        if (command.mode !== 'task-notification') continue
        for (const [path, words] of queuedNotices) {
          if (command.value !== words) continue
          publishAtomicSync(path + '.delivered', new Date().toISOString(), { mode: 0o600 })
          queuedNotices.delete(path)
        }
      }
    })
    observingConsumption = true
  }
  const dir = join(hostDirectory(), 'notices')
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const path = join(dir, name)
    const row = readNotice(path)
    if (row === undefined || row.sessionId !== sessionId || existsSync(path + '.delivered') || queuedNotices.has(path)) continue
    queuedNotices.set(path, row.words)
    enqueuePendingNotification({ value: row.words, mode: 'task-notification', priority: 'next' })
  }
}
function readNotice(path: string): { sessionId: string; words: string } | undefined {
  try {
    const row: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof row === 'object' && row !== null && 'sessionId' in row && typeof row.sessionId === 'string' && 'words' in row && typeof row.words === 'string') return { sessionId: row.sessionId, words: row.words }
    throw new Error('not a notice record')
  } catch (error) {
    if (!damagedNotices.has(path)) logForDebugging('Host notice ' + path + ' skipped: ' + errorMessage(error))
    damagedNotices.add(path)
    return undefined
  }
}
export function watchHostNotices(sessionId: () => string): () => void {
  const tick = (): void => { try { deliverHostNotices(sessionId()) } catch {} }
  const timer = setInterval(tick, 1000); timer.unref(); tick()
  return () => clearInterval(timer)
}
