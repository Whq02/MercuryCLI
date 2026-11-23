import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonHomeStands, publishInDaemonHome } from '../control/daemonHome.js'
import { daemonDir } from '../control/controlSocket.js'
import type { WorkspaceIsolation } from './admission.js'
import { withDaemonStoreLock } from './storeLock.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage, isENOENT } from '../../platform/errors/errors.js'

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

function rowsOfCollisionFile(text: string): CollisionEvidenceV1[] {
  const raw = JSON.parse(text) as CollisionFileV1
  if (!raw || raw.version !== 1 || !Array.isArray(raw.rows)) return []
  return raw.rows
}

export function readCollisionEvidenceStrict(dir?: string): CollisionEvidenceV1[] {
  let text: string
  try {
    text = readFileSync(concourseCollisionsPath(dir), 'utf8')
  } catch (error) {
    if (isENOENT(error)) return []
    throw error
  }
  const raw = JSON.parse(text) as CollisionFileV1
  if (!raw || raw.version !== 1 || !Array.isArray(raw.rows)) {
    throw new Error('invalid collision evidence format')
  }
  return raw.rows
}

export function readCollisionEvidence(dir?: string): CollisionEvidenceV1[] {
  try {
    return rowsOfCollisionFile(readFileSync(concourseCollisionsPath(dir), 'utf8'))
  } catch (error) {
    passedOver(error)
    return []
  }
}

function readCollisionEvidenceToRewrite(path: string): CollisionEvidenceV1[] | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return []
    logForDebugging(`[concourse] the collision evidence at ${path} could not be read (${errorMessage(error)}), so it is not written over`)
    return null
  }
  try {
    return rowsOfCollisionFile(text)
  } catch (error) {
    passedOver(error)
    return []
  }
}

function updateCollisionEvidence(mutate: (rows: CollisionEvidenceV1[]) => CollisionEvidenceV1[], dir?: string): void {
  const path = concourseCollisionsPath(dir)
  withDaemonStoreLock('the collision evidence', path, dir, ({ homeGone, assertStillHeld }) => {
    const held = readCollisionEvidenceToRewrite(path)
    if (held === null) return
    const rows = mutate(held)
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
