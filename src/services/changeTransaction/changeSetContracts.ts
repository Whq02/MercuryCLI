
import { join } from 'node:path'
import { getMercuryHome, isEnvDefinedFalsy } from '../../utils/envUtils.js'
import type { LineEndingType } from '../../utils/fileRead.js'
import type { BoundedDiffHunk } from './diffBudget.js'
import { changeTransactionEnabled } from './contracts.js'
import { editHunksEnabled, type EditHunkInput, type HunkSpan } from './hunks.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export const CHANGESET_CONTRACT_VERSION = 1

export function changeSetEnabled(): boolean {
  return (
    changeTransactionEnabled() &&
    editHunksEnabled() &&
    !isEnvDefinedFalsy(flagEnv('MERCURY_CHANGESET'))
  )
}

export function changeSetHomeDir(): string {
  const pinned = flagEnv('MERCURY_CHANGESET_DIR')
  return pinned && pinned.length > 0
    ? pinned
    : join(getMercuryHome(), 'changesets')
}

export function changeSetJournalDir(): string {
  return join(changeSetHomeDir(), 'journal')
}

export function changeSetBundleRoot(): string {
  return join(changeSetHomeDir(), 'bundles')
}


export const CHANGESET_BOUNDS = {
  maxFiles: 16,
  maxHunksPerFile: 32,
  maxHunksTotal: 128,
  maxStagedBytes: 4_000_000,
  maxDiffLines: 240,
  planRing: 16,
  planTtlMs: 30 * 60_000,
  bundleKeepTerminal: 8,
} as const


export interface ChangeSetMemberInput {
  file_path: string
  expected_anchor: string
  hunks: EditHunkInput[]
  op?: 'edit' | 'delete' | 'move'
  new_path?: string
}


export interface ChangeSetTargetPlan {
  requestedPath: string
  canonicalPath: string
  expectedAnchor: string
  observedAnchor: string
  originalDigest: string
  plannedDigest: string
  originalByteLength: number
  plannedByteLength: number
  encoding: BufferEncoding
  lineEndings: LineEndingType
  finalNewline: boolean
  mode: number
  hunkSpans: HunkSpan[]
  plannedContent: string
  diff: { hunks: BoundedDiffHunk[]; omittedHunks: number }
  changed: boolean
  fileOp?: 'delete' | 'move'
  newPath?: string
}

export interface ChangeSetTargetBytes {
  canonicalPath: string
  originalBytes: Buffer
  plannedBytes: Buffer
}


export type ChangeSetPlanState =
  | 'prepared'
  | 'applied'
  | 'no-change'
  | 'stale'
  | 'failed'
  | 'indeterminate'
  | 'discarded'
  | 'expired'
  | 'cancelled'
  | 'recovered'

export interface ChangeSetPlan {
  version: typeof CHANGESET_CONTRACT_VERSION
  id: string
  digest: string
  ownerKey: string
  createdAt: number
  expiresAt: number
  state: ChangeSetPlanState
  targets: ChangeSetTargetPlan[]
  changedPaths: string[]
  noChangePaths: string[]
  totalHunks: number
  note?: string
  appliedAt?: number
  operationId?: string
}


export type ChangeSetRefusalCode =
  | 'schema'
  | 'bounds'
  | 'duplicate-path'
  | 'missing'
  | 'directory'
  | 'notebook'
  | 'binary'
  | 'not-read'
  | 'stale-anchor'
  | 'malformed-anchor'
  | 'hunks'
  | 'destination'
  | 'scope'
  | 'denied'
  | 'absent'
  | 'expired'
  | 'discarded'
  | 'already-applied'
  | 'foreign-owner'
  | 'stale-plan'
  | 'cancelled'
  | 'in-flight'
  | 'io'

export interface ChangeSetMemberFailure {
  path: string
  code: ChangeSetRefusalCode
  message: string
}

export interface ChangeSetRefusal {
  ok: false
  code: ChangeSetRefusalCode
  message: string
  failures?: ChangeSetMemberFailure[]
  recovery: string
}

export interface ChangeSetPlanned {
  ok: true
  plan: ChangeSetPlan
  bytes: Map<string, ChangeSetTargetBytes>
}

export type ChangeSetPlanResult = ChangeSetPlanned | ChangeSetRefusal
