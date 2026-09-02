// ============================================================================
//  providers/openai/qualificationStore — the digest-tied qualification-receipt
//  store.
//
//  A model appears in an GPT role only with a CURRENT receipt tied to
//  {model id · adapter/schema digest · role id · role-capability digest ·
//  behaviour-contract digest · architecture epoch}. This store:
//
//    - mints receipts from OBSERVED LIVE settlements only (openaiCallModel's
//      settlement seam — a receipt can never exist without a real turn);
//    - persists them under the AUTH SCOPE (`.apex-qualification.json` beside
//      `.openai-auth.json` — receipts are account-source evidence and follow
//      the account slot), versioned, no secrets ever;
//    - enforces digest currency on READ: an adapter/epoch/role-digest
//      mismatch is an EXPIRED receipt (filtered with the reason available),
//      never a silent pass — re-qualification is a fresh live settlement.
//
//  The ROLE-CAPABILITY DIGESTS are versioned literals over each role's
// mandatory capability list (brief): change the contract ⇒ bump
//  the list ⇒ every prior receipt for that role expires mechanically.
// ============================================================================
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

// ── Role-capability digests (versioned literals over) ─────────────

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
  'scribe-router': ['typed-route-envelope-production', 'decomposition', 'effort-model-targeting', 'carry-forward', 'dedup', 'halt-stop', 'burst-handling', 'deterministic-dispatch-settlement'],
  'scribe-implementer': ['routed-envelope-consumption', 'repository-work', 'verification-output', 'evidence-return', 'cancellation', 'exactly-once-bus-completion'],
  specialist: ['bounded-job-execution', 'structured-result-return', 'worktree-law', 'role-tool-denials'],
  // the Concourse coordinator's contract —
  // bounded snapshot+delta input, ONLY the enumerated management verbs, one
  // proposal batch per triggering event, kernel-permitted actions with
  // receipted settlement, and no self-approval of its own proposals.
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
  // TOTAL over stored strings: an old receipt may carry a RETIRED role id
  // (the party seats left with the multiplayer estate). A role without a
  // capability row digests to a retired marker no live digest can equal, so
  // receiptCurrency expires such receipts mechanically instead of crashing —
  // the doctrine's own "not in the list ⇒ expires" path.
  const capabilities = (ROLE_CAPABILITIES as Partial<Record<string, readonly string[]>>)[role]
  if (capabilities === undefined) return 'rc1-retired-role'
  const hash = createHash('sha256')
  for (const capability of capabilities) {
    hash.update(capability)
    hash.update('')
  }
  return `rc1-${hash.digest('hex').slice(0, 16)}`
}

// ── The persisted receipt ───────────────────────────────────────────────────

export interface StoredQualificationReceipt {
  modelId: string
  role: ApexGptRole
  sourceKind: OpenaiAccountSourceKind
  adapterDigest: string
  architectureEpoch: string
  roleCapabilityDigest: string
  /** The A3 behaviour-contract digest active on the qualifying turn. */
  behaviourContractDigest?: string
  /** Live facts at qualification. */
  liveEffort?: string
  responseId?: string
  /** a fixture/novel id's human name — the registry paints it when
   *  the live catalogue has no row of its own for this id. */
  displayName?: string
  qualifiedAtMs: number
}

interface QualificationFile {
  version: number
  receipts: StoredQualificationReceipt[]
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
    /* absent/damaged ⇒ fresh (receipts are re-mintable evidence, never data) */
  }
  return { version: FILE_VERSION, receipts: [] }
}

/**
 * Mint + persist a receipt from an OBSERVED live settlement. Replaces the
 * (model, role, source) row; bounded; best-effort (a store failure never
 * touches the turn). Never called without a settled live turn.
 */
export function recordLiveQualification(i: {
  modelId: string
  role: ApexGptRole
  sourceKind: OpenaiAccountSourceKind
  behaviourContractDigest?: string
  liveEffort?: string
  responseId?: string
  /** the id's human name for registry paint (novel/fixture ids). */
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

/** Digest-currency check — the digest tie, enforced mechanically. */
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

/** All stored receipts with currency evaluated (read surface for /router
 *  engines · doctor · the closure report). */
export function readQualificationReceipts(): ReceiptCurrency[] {
  return readFile().receipts.map(receiptCurrency)
}

/** Proof seam. */
export function __qualificationFilePathForTest(): string {
  return filePath()
}
