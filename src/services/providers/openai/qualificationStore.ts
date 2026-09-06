import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAuthConfigHomeDir } from '../../../utils/envUtils.js'
import {
  APEX_ARCHITECTURE_EPOCH,
  OPENAI_ADAPTER_DIGEST,
  type ApexGptRole,
} from './openaiCatalogue.js'
import type { OpenaiAccountSourceKind } from './openaiAccounts.js'


const ROLE_CAPABILITIES: Record<ApexGptRole, readonly string[]> = {
  primary: [
    'persistent-foreground-conversation',
    'per-turn-model-selection',
    'per-turn-live-effort',
    'streamed-assistant-text',
    'cancellation-exactly-once-settlement',
    'project-cwd+instructions',
    'behaviour-contract-delivery',
    'session-persist+resume',
    'transport-interruption-recovery',
    'usage-projection',
    'compaction+branch-continuity',
    'tool-projection',
    'headless+interactive-output',
    'switch-transition-receipts',
    'no-lost-input+no-duplicate-events',
  ],
  specialist: ['bounded-job-execution', 'structured-result-return', 'worktree-law', 'role-tool-denials'],
  coordinator: [
    'bounded-snapshot+delta-consumption',
    'typed-management-verbs-only',
    'single-proposal-batch-per-event',
    'kernel-permitted-actions',
    'receipted-settlement',
    'no-self-approval',
  ],
}

export function roleCapabilityDigest(role: ApexGptRole): string {
  const capabilities = (ROLE_CAPABILITIES as Partial<Record<string, readonly string[]>>)[role]
  if (capabilities === undefined) return 'rc1-retired-role'
  const hash = createHash('sha256')
  for (const capability of capabilities) {
    hash.update(capability)
    hash.update('')
  }
  return `rc1-${hash.digest('hex').slice(0, 16)}`
}


export interface StoredQualificationReceipt {
  modelId: string
  role: ApexGptRole
  sourceKind: OpenaiAccountSourceKind
  adapterDigest: string
  architectureEpoch: string
  roleCapabilityDigest: string
  behaviourContractDigest?: string
  liveEffort?: string
  responseId?: string
  displayName?: string
  qualifiedAtMs: number
}

interface QualificationFile {
  version: number
  receipts: StoredQualificationReceipt[]
  wireEfforts?: StoredWireEffortVocabulary[]
  [k: string]: unknown
}

const FILE_VERSION = 1
const FILE_NAME = '.apex-qualification.json'
const MAX_RECEIPTS = 64

function filePath(): string {
  return join(getAuthConfigHomeDir(), FILE_NAME)
}

function readFile(): QualificationFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath(), 'utf8')) as unknown
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as QualificationFile).receipts)) {
      return parsed as QualificationFile
    }
  } catch {
  }
  return { version: FILE_VERSION, receipts: [] }
}

export function recordLiveQualification(i: {
  modelId: string
  role: ApexGptRole
  sourceKind: OpenaiAccountSourceKind
  behaviourContractDigest?: string
  liveEffort?: string
  responseId?: string
  displayName?: string
  now?: () => number
}): StoredQualificationReceipt | undefined {
  const receipt: StoredQualificationReceipt = {
    modelId: i.modelId.toLowerCase(),
    role: i.role,
    sourceKind: i.sourceKind,
    adapterDigest: OPENAI_ADAPTER_DIGEST,
    architectureEpoch: APEX_ARCHITECTURE_EPOCH,
    roleCapabilityDigest: roleCapabilityDigest(i.role),
    ...(i.behaviourContractDigest ? { behaviourContractDigest: i.behaviourContractDigest } : {}),
    ...(i.liveEffort ? { liveEffort: i.liveEffort } : {}),
    ...(i.responseId ? { responseId: i.responseId } : {}),
    ...(i.displayName ? { displayName: i.displayName } : {}),
    qualifiedAtMs: (i.now ?? Date.now)(),
  }
  try {
    const file = readFile()
    const kept = file.receipts.filter(
      r => !(r.modelId === receipt.modelId && r.role === receipt.role && r.sourceKind === receipt.sourceKind),
    )
    kept.push(receipt)
    while (kept.length > MAX_RECEIPTS) kept.shift()
    writeFileSync(filePath(), JSON.stringify({ ...file, version: FILE_VERSION, receipts: kept }, null, 2) + '\n', 'utf8')
    return receipt
  } catch {
    return undefined
  }
}

export type ReceiptCurrency =
  | { current: true; receipt: StoredQualificationReceipt }
  | { current: false; receipt: StoredQualificationReceipt; expiredBy: string }

export function receiptCurrency(receipt: StoredQualificationReceipt): ReceiptCurrency {
  if (receipt.architectureEpoch !== APEX_ARCHITECTURE_EPOCH) {
    return { current: false, receipt, expiredBy: `architecture epoch ${receipt.architectureEpoch} ≠ ${APEX_ARCHITECTURE_EPOCH}` }
  }
  if (receipt.adapterDigest !== OPENAI_ADAPTER_DIGEST) {
    return { current: false, receipt, expiredBy: 'adapter/schema digest changed' }
  }
  if (receipt.roleCapabilityDigest !== roleCapabilityDigest(receipt.role)) {
    return { current: false, receipt, expiredBy: `role-capability contract for '${receipt.role}' changed` }
  }
  return { current: true, receipt }
}

export function readQualificationReceipts(): ReceiptCurrency[] {
  return readFile().receipts.map(receiptCurrency)
}


export const WIRE_EFFORT_MEMORY_PROBE_MS = 24 * 60 * 60 * 1000

export function describeWireEffortProbeWindow(ms: number = WIRE_EFFORT_MEMORY_PROBE_MS): string {
  const hours = Math.round(ms / 3_600_000)
  if (hours === 24) return 'a day'
  if (hours === 1) return 'an hour'
  if (hours > 1 && hours % 24 === 0) return `${hours / 24} days`
  return `${hours} hours`
}

export interface StoredWireEffortVocabulary {
  modelId: string
  sourceKind: OpenaiAccountSourceKind
  levels: string[]
  refused: string
  observedAtMs: number
}

const WIRE_MEMORY_READ_CACHE_MS = 1000
let wireMemoryCache: { path: string; readAtMs: number; entries: StoredWireEffortVocabulary[] } | null = null

function isStoredWireEffortVocabulary(v: unknown): v is StoredWireEffortVocabulary {
  const o = v as Partial<StoredWireEffortVocabulary> | null
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o.modelId === 'string' &&
    typeof o.sourceKind === 'string' &&
    Array.isArray(o.levels) &&
    typeof o.refused === 'string' &&
    typeof o.observedAtMs === 'number'
  )
}

function readWireMemories(now: () => number): StoredWireEffortVocabulary[] {
  const path = filePath()
  if (wireMemoryCache !== null && wireMemoryCache.path === path && now() - wireMemoryCache.readAtMs < WIRE_MEMORY_READ_CACHE_MS) {
    return wireMemoryCache.entries
  }
  const raw = readFile().wireEfforts
  const entries = Array.isArray(raw) ? raw.filter(isStoredWireEffortVocabulary) : []
  wireMemoryCache = { path, readAtMs: now(), entries }
  return entries
}

function writeWireMemories(entries: StoredWireEffortVocabulary[]): boolean {
  try {
    const file = readFile()
    writeFileSync(filePath(), JSON.stringify({ ...file, version: FILE_VERSION, wireEfforts: entries }, null, 2) + '\n', 'utf8')
    wireMemoryCache = null
    return true
  } catch {
    return false
  }
}

const memoryKey = (modelId: string, sourceKind: OpenaiAccountSourceKind): string => `${sourceKind}:${modelId.toLowerCase()}`

export function recordWireEffortRefusal(i: {
  modelId: string
  sourceKind: OpenaiAccountSourceKind
  refused: string
  levels: readonly string[]
  now?: () => number
}): StoredWireEffortVocabulary | undefined {
  const now = i.now ?? Date.now
  const entry: StoredWireEffortVocabulary = {
    modelId: i.modelId.toLowerCase(),
    sourceKind: i.sourceKind,
    levels: [...i.levels],
    refused: i.refused,
    observedAtMs: now(),
  }
  const kept = readWireMemories(Date.now).filter(e => memoryKey(e.modelId, e.sourceKind) !== memoryKey(entry.modelId, entry.sourceKind))
  kept.push(entry)
  return writeWireMemories(kept) ? entry : undefined
}

export function wireEffortVocabularyOf(
  modelId: string,
  sourceKind: OpenaiAccountSourceKind,
  now: () => number = Date.now,
): StoredWireEffortVocabulary | undefined {
  const key = memoryKey(modelId, sourceKind)
  const entry = readWireMemories(now).find(e => memoryKey(e.modelId, e.sourceKind) === key)
  if (entry === undefined) return undefined
  return now() - entry.observedAtMs < WIRE_EFFORT_MEMORY_PROBE_MS ? entry : undefined
}

export function noteWireEffortAccepted(i: { modelId: string; sourceKind: OpenaiAccountSourceKind; word: string }): boolean {
  const key = memoryKey(i.modelId, i.sourceKind)
  const entries = readWireMemories(Date.now)
  const stale = entries.find(e => memoryKey(e.modelId, e.sourceKind) === key && !e.levels.includes(i.word))
  if (stale === undefined) return false
  return writeWireMemories(entries.filter(e => e !== stale))
}

export function readWireEffortVocabularies(): StoredWireEffortVocabulary[] {
  wireMemoryCache = null
  return readWireMemories(Date.now)
}

export function __qualificationFilePathForTest(): string {
  return filePath()
}
