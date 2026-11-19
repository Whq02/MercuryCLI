import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonHomeStands, publishInDaemonHome } from '../daemonHome.js'
import { daemonDir } from '../controlSocket.js'
import type { WorkspaceIsolation } from './admission.js'
import { withDaemonStoreLock } from './storeLock.js'

export interface CollisionEvidenceV1 {
  schema: 1
  kind: 'exclusive-overlap' | 'authored-work-retained'
  workspaceId: string
  holders: Array<{ workerId: string; sessionId?: string; isolation?: WorkspaceIsolation }>
  observedAt: number
  refusedClientMessageId?: string
  detail?: string
  files?: string[]
  branchName?: string
  consumedAt?: number
}

interface CollisionFileV1 {
  version: 1
  rows: CollisionEvidenceV1[]
}

const COLLISION_EVIDENCE_CAP = 100

export function concourseCollisionsPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-collisions.json')
}

export function readCollisionEvidence(dir?: string): CollisionEvidenceV1[] {
  try {
    const raw = JSON.parse(readFileSync(concourseCollisionsPath(dir), 'utf8')) as CollisionFileV1
    if (!raw || raw.version !== 1 || !Array.isArray(raw.rows)) return []
    return raw.rows
  } catch {
    return []
  }
}

function updateCollisionEvidence(mutate: (rows: CollisionEvidenceV1[]) => CollisionEvidenceV1[], dir?: string): void {
  const path = concourseCollisionsPath(dir)
  withDaemonStoreLock('the collision evidence', path, dir, ({ homeGone, assertStillHeld }) => {
    const rows = mutate(readCollisionEvidence(dir))
    if (homeGone || !daemonHomeStands('the collision evidence', dir)) return
    assertStillHeld()
    publishInDaemonHome(
      'the collision evidence',
      path,
      `${JSON.stringify({ version: 1, rows } satisfies CollisionFileV1, null, 1)}\n`,
      { dir },
    )
  })
}

export function recordCollisionEvidence(row: CollisionEvidenceV1, dir?: string): void {
  updateCollisionEvidence(rows => [...rows, row].slice(-COLLISION_EVIDENCE_CAP), dir)
}
