
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'

export const REVISION_KEY = '_rev'

export interface StoreRevision {
  revision: number
  writerId: string
  operationId: string
  committedAt: string
  digest: string
}

export type StoreReadState = 'ready' | 'missing' | 'recoverable'

export type StoreReadResult<T> =
  | { state: 'ready'; value: T; revision: StoreRevision | null }
  | { state: 'missing'; value: T }
  | {
      state: 'recoverable'
      reason: string
      path: string
      lastGood?: T
    }

export type StoreChangeCause = 'local-commit' | 'watch' | 'catch-up' | 'recovery'

export interface StoreChange<T> {
  value: T
  revision: StoreRevision | null
  cause: StoreChangeCause
  skippedRevisions: number
}

export function payloadDigest(encodedSansMeta: string): string {
  return createHash('sha256').update(encodedSansMeta).digest('hex').slice(0, 16)
}

export function nextRevision(prev: StoreRevision | null, digest: string): StoreRevision {
  return {
    revision: (prev?.revision ?? 0) + 1,
    writerId: `pid:${process.pid}`,
    operationId: randomUUID(),
    committedAt: new Date().toISOString(),
    digest,
  }
}

export function parseRevision(raw: unknown): StoreRevision | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rev = (raw as Record<string, unknown>)[REVISION_KEY]
  if (!rev || typeof rev !== 'object') return null
  const r = rev as Partial<StoreRevision>
  if (
    typeof r.revision !== 'number' ||
    !Number.isFinite(r.revision) ||
    typeof r.operationId !== 'string'
  ) {
    return null
  }
  return {
    revision: r.revision,
    writerId: typeof r.writerId === 'string' ? r.writerId : 'unknown',
    operationId: r.operationId,
    committedAt: typeof r.committedAt === 'string' ? r.committedAt : '',
    digest: typeof r.digest === 'string' ? r.digest : '',
  }
}

export function skippedBetween(
  lastSeen: number | null,
  next: StoreRevision | null,
): number {
  if (lastSeen === null || next === null) return 0
  return Math.max(0, next.revision - lastSeen - 1)
}
