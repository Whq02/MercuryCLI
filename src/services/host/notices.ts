import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { hostDirectory, type HostRecord } from './store.js'

export function hostNotice(record: HostRecord, kind: string, words: string): void {
  if (!record.sessionId) return
  const dir = join(hostDirectory(), 'notices')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const id = createHash('sha256').update([record.id, record.generation, kind].join(':')).digest('hex')
  const path = join(dir, id + '.json')
  if (!existsSync(path)) durableAtomicPublishSync(path, JSON.stringify({ id, sessionId: record.sessionId, words }), { mode: 0o600 })
}
export function deliverHostNotices(sessionId: string): void {
  const dir = join(hostDirectory(), 'notices')
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const path = join(dir, name)
    const row = JSON.parse(readFileSync(path, 'utf8')) as { sessionId: string; words: string; id: string }
    if (row.sessionId !== sessionId || existsSync(path + '.delivered')) continue
    enqueuePendingNotification({ value: row.words, mode: 'task-notification', priority: 'next' })
    writeFileSync(path + '.delivered', new Date().toISOString(), { mode: 0o600 })
  }
}
export function watchHostNotices(sessionId: () => string): () => void {
  const tick = (): void => { try { deliverHostNotices(sessionId()) } catch {} }
  const timer = setInterval(tick, 1000); timer.unref(); tick()
  return () => clearInterval(timer)
}
