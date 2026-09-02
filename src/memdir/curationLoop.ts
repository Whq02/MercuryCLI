// ============================================================================
//  src/memdir/curationLoop.ts — the consolidation loop as MECHANISM: the
//  engine itself proposes merges of duplicate memories, decay of stale
//  ones, and contradiction retirements — and applies an approved proposal
//  through the audit spine, never as silent destruction.
//
//  THE SHAPE — propose / consent / apply, three separable steps:
//    · proposeCuration scans one memory directory (the same scan recall
//      uses, so curation and recall agree about what exists) and emits
//      TYPED proposals, each carrying its machine-checkable reason;
//    · proposals PERSIST under <dir>/.curation/proposals.json — the
//      consent surfaces (Memory Centre, the consolidation agent's brief)
//      read them there; nothing applies by side effect of proposing;
//    · applyCurationProposals executes ONLY what the caller hands it,
//      stamps every action into <dir>/.curation/receipts.jsonl, and
//      retires content through the .superseded. audit-copy machinery the
//      card store already trusts — the file leaves recall but stays on
//      disk, reversible, with the receipt naming why and on whose consent.
//
//  DETECTION CLASSES (deterministic, precision over recall):
//    merge-duplicates   identical normalized bodies (hash-equal after
//                       frontmatter/whitespace fold) — the SAFE class; and
//                       near-duplicates by description-token overlap —
//                       judgment class, proposal only.
//    contradiction      a live file whose frontmatter `supersedes:` names
//                       another file that STILL EXISTS live — the newer
//                       fact already claims to disprove the older one, so
//                       retiring the older is completing a recorded intent
//                       (delete-with-receipt) — SAFE class.
//    decay              a `project`-type memory past the decay window (the
//                       taxonomy's own "project memories decay fast"), or
//                       any memory whose checkable referents are gone
//                       (memoryReferents) — judgment class, proposal only.
//
//  Consent is the CALLER's law: background maintenance only ever proposes;
//  the Memory Centre applies the safe classes on an operator's explicit
//  action; the consolidation agent receives proposals as brief input and
//  works them through its own permission-checked file tools. approvedBy is
//  recorded verbatim in every receipt.
// ============================================================================
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { durableAtomicPublish } from '../substrate/durablePublish.js'
import { logForDebugging } from '../utils/debug.js'
import { serializeIndexUpdate, writeSupersededCopy, ENTRYPOINT_NAME } from './experienceCards.js'
import { memoryAgeDays } from './memoryAge.js'
import { verifyMemoryReferents } from './memoryReferents.js'
import { scanMemoryFiles, type MemoryHeader } from './memoryScan.js'

export const CURATION_DIR = '.curation'
export const PROPOSALS_BASENAME = 'proposals.json'
export const RECEIPTS_BASENAME = 'receipts.jsonl'

/** Days after which an un-touched `project`-type memory is proposed for
 *  decay — the taxonomy's own "these states change quickly" clause given a
 *  number. Proposals only; nothing decays without consent. */
export const PROJECT_DECAY_DAYS = 120

/** Description-token Jaccard at or above which two same-type memories are
 *  proposed as near-duplicates (judgment class). */
export const NEAR_DUP_JACCARD = 0.6

export type CurationProposal =
  | {
      kind: 'merge-duplicates'
      /** Newest file of the cluster — the survivor. */
      canonical: string
      duplicates: string[]
      /** 'identical content' marks the SAFE class; token-overlap reasons
       *  mark the judgment class. */
      reason: string
      safe: boolean
    }
  | {
      kind: 'contradiction'
      disproven: string
      disprovenBy: string
      reason: string
      safe: true
    }
  | {
      kind: 'decay'
      file: string
      reason: string
      safe: false
    }

export interface CurationSweep {
  schema: 1
  sweptAt: string
  scanned: number
  proposals: CurationProposal[]
}

const curationDir = (memoryDir: string): string => join(memoryDir, CURATION_DIR)
export const proposalsPath = (memoryDir: string): string => join(curationDir(memoryDir), PROPOSALS_BASENAME)
export const receiptsPath = (memoryDir: string): string => join(curationDir(memoryDir), RECEIPTS_BASENAME)

/** Body with frontmatter stripped, whitespace folded, case folded — the
 *  identity under which two memories count as the same fact. */
export function normalizedBody(markdown: string): string {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')
  return body.toLowerCase().replace(/\s+/g, ' ').trim()
}

const tokensOf = (text: string | null): Set<string> =>
  new Set((text ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let hit = 0
  for (const t of a) if (b.has(t)) hit++
  return hit / (a.size + b.size - hit)
}

interface LoadedMemory {
  header: MemoryHeader
  markdown: string
  supersedes: string | null
}

/** The frontmatter `supersedes:` edge, wherever in the block it sits. */
function supersedesEdge(markdown: string): string | null {
  const fm = markdown.match(/^---\n[\s\S]*?\n---/)
  if (!fm) return null
  const edge = fm[0].match(/\n\s*supersedes:\s*['"]?([^'"\n]+\.md)['"]?/)
  return edge?.[1]?.trim() ?? null
}

const READ_CAP_BYTES = 128 * 1024

export interface ProposeCurationOptions {
  /** Root for referent verification; absent skips the referent class. */
  projectRoot?: string
  decayAfterDays?: number
  now?: number
}

/**
 * Scan one memory directory and propose curation. Pure over the scan +
 * bounded reads; writes nothing. A directory that cannot be scanned
 * answers an empty sweep — the loop never invents work.
 */
export async function proposeCuration(
  memoryDir: string,
  options: ProposeCurationOptions = {},
): Promise<CurationSweep> {
  const sweptAt = new Date(options.now ?? Date.now()).toISOString()
  const headers = await scanMemoryFiles(memoryDir, new AbortController().signal)
  const loaded: LoadedMemory[] = []
  for (const header of headers) {
    try {
      const markdown = readFileSync(header.absolutePath, 'utf8').slice(0, READ_CAP_BYTES)
      loaded.push({ header, markdown, supersedes: supersedesEdge(markdown) })
    } catch {
      // An unreadable file is the scan's business, not curation's.
    }
  }
  const byFilename = new Map(loaded.map(m => [basename(m.header.filename), m]))
  const proposals: CurationProposal[] = []

  // ── merge-duplicates: identical bodies (safe), then near-dups (judgment) ──
  const byBodyHash = new Map<string, LoadedMemory[]>()
  for (const m of loaded) {
    const norm = normalizedBody(m.markdown)
    if (norm === '') continue
    const hash = createHash('sha256').update(norm).digest('hex')
    byBodyHash.set(hash, [...(byBodyHash.get(hash) ?? []), m])
  }
  const inExactCluster = new Set<string>()
  for (const cluster of byBodyHash.values()) {
    if (cluster.length < 2) continue
    const sorted = [...cluster].sort((a, b) => b.header.mtimeMs - a.header.mtimeMs)
    for (const m of sorted) inExactCluster.add(m.header.filename)
    proposals.push({
      kind: 'merge-duplicates',
      canonical: sorted[0]!.header.filename,
      duplicates: sorted.slice(1).map(m => m.header.filename),
      reason: 'identical content',
      safe: true,
    })
  }
  for (let i = 0; i < loaded.length; i++) {
    for (let j = i + 1; j < loaded.length; j++) {
      const a = loaded[i]!
      const b = loaded[j]!
      if (a.header.type !== b.header.type) continue
      if (inExactCluster.has(a.header.filename) || inExactCluster.has(b.header.filename)) continue
      const overlap = jaccard(tokensOf(a.header.description), tokensOf(b.header.description))
      if (overlap >= NEAR_DUP_JACCARD) {
        const newer = a.header.mtimeMs >= b.header.mtimeMs ? a : b
        const older = newer === a ? b : a
        proposals.push({
          kind: 'merge-duplicates',
          canonical: newer.header.filename,
          duplicates: [older.header.filename],
          reason: `descriptions overlap ${(overlap * 100).toFixed(0)}% on the same type — likely the same fact told twice`,
          safe: false,
        })
      }
    }
  }

  // ── contradiction: a recorded supersede whose target is still live ────────
  for (const m of loaded) {
    if (!m.supersedes) continue
    const target = byFilename.get(basename(m.supersedes))
    if (target && target.header.filename !== m.header.filename) {
      proposals.push({
        kind: 'contradiction',
        disproven: target.header.filename,
        disprovenBy: m.header.filename,
        reason: `${m.header.filename} records supersedes: ${basename(m.supersedes)}, but the superseded file is still live in recall`,
        safe: true,
      })
    }
  }

  // ── decay: aged project facts + broken-referent memories (judgment) ───────
  const decayAfter = options.decayAfterDays ?? PROJECT_DECAY_DAYS
  for (const m of loaded) {
    const age = memoryAgeDays(m.header.mtimeMs)
    if (m.header.type === 'project' && age > decayAfter) {
      proposals.push({
        kind: 'decay',
        file: m.header.filename,
        reason: `project-type memory untouched for ${age} days (window ${decayAfter}) — project states decay fast`,
        safe: false,
      })
      continue
    }
    if (options.projectRoot && age > 7) {
      const verdict = verifyMemoryReferents(m.markdown, { projectRoot: options.projectRoot })
      if (verdict.missing.length > 0) {
        proposals.push({
          kind: 'decay',
          file: m.header.filename,
          reason: `names ${verdict.missing.map(r => r.token).join(', ')} which no longer exist${verdict.missing.length === 1 ? 's' : ''} — the world it describes has moved`,
          safe: false,
        })
      }
    }
  }

  return { schema: 1, sweptAt, scanned: headers.length, proposals }
}

/** Persist a sweep for the consent surfaces. An empty sweep still writes —
 *  "swept, nothing to propose" is a fact the surfaces show. */
export async function writeCurationSweep(memoryDir: string, sweep: CurationSweep): Promise<string> {
  const path = proposalsPath(memoryDir)
  mkdirSync(dirname(path), { recursive: true })
  await durableAtomicPublish(path, JSON.stringify(sweep, null, 2))
  return path
}

/** The persisted sweep, or null (missing/corrupt both answer null — the
 *  surfaces treat either as "no pending proposals"). */
export function readCurationSweep(memoryDir: string): CurationSweep | null {
  try {
    const parsed = JSON.parse(readFileSync(proposalsPath(memoryDir), 'utf8')) as CurationSweep
    return parsed && parsed.schema === 1 && Array.isArray(parsed.proposals) ? parsed : null
  } catch {
    return null
  }
}

export interface CurationReceipt {
  at: string
  kind: CurationProposal['kind'] | 'agent-edit'
  /** Files retired to audit copies by this action. */
  retired: string[]
  /** The audit-copy paths the retired files moved to. */
  auditCopies: string[]
  survivor?: string
  reason: string
  approvedBy: string
}

export interface ApplyCurationResult {
  applied: CurationReceipt[]
  /** Proposals refused with the reason (safe-class violation, missing
   *  file, …) — refusal is loud, never silent. */
  refused: Array<{ proposal: CurationProposal; reason: string }>
}

/**
 * Retire one live memory file through the audit spine: superseded audit
 * copy written first, then the live file removed, then its index line
 * dropped. Crash between steps leaves BOTH copies (recoverable), never
 * neither.
 */
async function retireToAudit(memoryDir: string, filename: string): Promise<string> {
  const livePath = join(memoryDir, filename)
  const markdown = readFileSync(livePath, 'utf8')
  const auditPath = await writeSupersededCopy(memoryDir, basename(filename), markdown, new Date().toISOString())
  unlinkSync(livePath)
  await serializeIndexUpdate(join(memoryDir, ENTRYPOINT_NAME), existing => {
    const kept = existing
      .split('\n')
      .filter(line => !line.includes(`](${basename(filename)})`))
      .join('\n')
    return kept === existing ? null : kept
  })
  return auditPath
}

/**
 * Apply the handed proposals. `safeOnly` (the default) refuses judgment-
 * class proposals — the Memory Centre's one-key action and any automated
 * caller stay inside the mechanically-provable classes; an explicit
 * operator/agent decision passes safeOnly:false for a specific proposal.
 */
export async function applyCurationProposals(
  memoryDir: string,
  proposals: readonly CurationProposal[],
  options: { approvedBy: string; safeOnly?: boolean },
): Promise<ApplyCurationResult> {
  const safeOnly = options.safeOnly ?? true
  const applied: CurationReceipt[] = []
  const refused: ApplyCurationResult['refused'] = []
  for (const proposal of proposals) {
    if (safeOnly && !proposal.safe) {
      refused.push({ proposal, reason: 'judgment-class proposal under a safe-only apply' })
      continue
    }
    try {
      if (proposal.kind === 'merge-duplicates') {
        const missing = proposal.duplicates.filter(f => !existsSync(join(memoryDir, f)))
        if (missing.length > 0 || !existsSync(join(memoryDir, proposal.canonical))) {
          refused.push({ proposal, reason: `file(s) moved since the sweep: ${[...missing, ...(existsSync(join(memoryDir, proposal.canonical)) ? [] : [proposal.canonical])].join(', ')}` })
          continue
        }
        const auditCopies: string[] = []
        for (const duplicate of proposal.duplicates) {
          auditCopies.push(await retireToAudit(memoryDir, duplicate))
        }
        applied.push(receiptRow(proposal.kind, proposal.duplicates, auditCopies, proposal.reason, options.approvedBy, proposal.canonical))
      } else if (proposal.kind === 'contradiction') {
        if (!existsSync(join(memoryDir, proposal.disproven)) || !existsSync(join(memoryDir, proposal.disprovenBy))) {
          refused.push({ proposal, reason: 'file(s) moved since the sweep' })
          continue
        }
        const auditPath = await retireToAudit(memoryDir, proposal.disproven)
        applied.push(receiptRow(proposal.kind, [proposal.disproven], [auditPath], proposal.reason, options.approvedBy, proposal.disprovenBy))
      } else {
        if (!existsSync(join(memoryDir, proposal.file))) {
          refused.push({ proposal, reason: 'file moved since the sweep' })
          continue
        }
        const auditPath = await retireToAudit(memoryDir, proposal.file)
        applied.push(receiptRow(proposal.kind, [proposal.file], [auditPath], proposal.reason, options.approvedBy))
      }
    } catch (error) {
      refused.push({ proposal, reason: `apply failed: ${String(error)}` })
    }
  }
  if (applied.length > 0) {
    try {
      const path = receiptsPath(memoryDir)
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, applied.map(r => JSON.stringify(r)).join('\n') + '\n')
    } catch (error) {
      logForDebugging(`curation receipts append failed: ${String(error)}`)
    }
  }
  return { applied, refused }
}

function receiptRow(
  kind: CurationProposal['kind'] | 'agent-edit',
  retired: string[],
  auditCopies: string[],
  reason: string,
  approvedBy: string,
  survivor?: string,
): CurationReceipt {
  return {
    at: new Date().toISOString(),
    kind,
    retired,
    auditCopies,
    ...(survivor !== undefined ? { survivor } : {}),
    reason,
    approvedBy,
  }
}

/** The receipts, newest last; a missing/corrupt ledger answers empty. */
export function readCurationReceipts(memoryDir: string): CurationReceipt[] {
  try {
    return readFileSync(receiptsPath(memoryDir), 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .flatMap(line => {
        try {
          return [JSON.parse(line) as CurationReceipt]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/**
 * Audit-on-write for the consolidation AGENT's own file edits: before an
 * Edit/Write inside the memory store rewrites an existing content file, the
 * prior body is snapshotted through the SAME audit spine the mechanical
 * applies use, with a receipt naming the tool. This closes the unreceipted-
 * destruction corridor the agent's judgment-class disposals ran through —
 * every disposal path now leaves an audit copy and a ledger row. Skips the
 * index (pointer-line maintenance, not content), audit copies themselves,
 * the .curation ledger, and non-markdown files. Best-effort by contract:
 * a failed snapshot logs and never blocks the agent's tool call, and an
 * identical prior body re-snapshots to the SAME audit filename (content-
 * hash suffix), so repeated edits stay idempotent on disk.
 */
export async function auditAgentMemoryWrite(
  memoryDir: string,
  filePath: string,
  toolName: string,
): Promise<void> {
  try {
    const name = basename(filePath)
    if (!name.endsWith('.md')) return
    if (name === ENTRYPOINT_NAME) return
    if (name.includes('.superseded.')) return
    if (filePath.includes(`/${CURATION_DIR}/`)) return
    if (!existsSync(filePath)) return
    const prior = readFileSync(filePath, 'utf8')
    if (prior.trim() === '') return
    // Stamped by the PRIOR's own mtime, not the wall clock: an unchanged
    // body re-snapshots to the SAME audit filename (stamp + content hash),
    // so repeated agent edits of one file stay idempotent on disk.
    const auditPath = await writeSupersededCopy(
      dirname(filePath),
      name,
      prior,
      statSync(filePath).mtime.toISOString(),
    )
    const row = receiptRow(
      'agent-edit',
      [name],
      [auditPath],
      `pre-edit snapshot before ${toolName} by the consolidation agent`,
      'consolidation-agent',
    )
    const path = receiptsPath(memoryDir)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(row) + '\n')
  } catch (error) {
    logForDebugging(`curation audit-on-write failed: ${String(error)}`)
  }
}

/**
 * Render a sweep for the consolidation agent's brief — the mechanism
 * feeding the judgment loop. Empty sweep ⇒ empty string (no section).
 */
export function renderProposalsForBrief(sweep: CurationSweep | null): string {
  if (!sweep || sweep.proposals.length === 0) return ''
  const lines = sweep.proposals.map(p => {
    if (p.kind === 'merge-duplicates') {
      return `- merge: keep ${p.canonical}, fold ${p.duplicates.join(', ')} (${p.reason})`
    }
    if (p.kind === 'contradiction') {
      return `- contradiction: ${p.disproven} is disproven by ${p.disprovenBy} (${p.reason})`
    }
    return `- decay: ${p.file} (${p.reason})`
  })
  return [
    `The curation engine swept this store at ${sweep.sweptAt} and proposes:`,
    ...lines,
    'Weigh each proposal on the actual content — merge what is truly the same fact (weaving detail from both into the survivor), correct or delete what is truly disproven or dead, and leave anything you judge still load-bearing. State what you did with each.',
  ].join('\n')
}
