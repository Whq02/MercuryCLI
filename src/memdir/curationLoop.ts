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

export const PROJECT_DECAY_DAYS = 120

export const NEAR_DUP_JACCARD = 0.6

export type CurationProposal =
  | {
      kind: 'merge-duplicates'
      canonical: string
      duplicates: string[]
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

function supersedesEdge(markdown: string): string | null {
  const fm = markdown.match(/^---\n[\s\S]*?\n---/)
  if (!fm) return null
  const edge = fm[0].match(/\n\s*supersedes:\s*['"]?([^'"\n]+\.md)['"]?/)
  return edge?.[1]?.trim() ?? null
}

const READ_CAP_BYTES = 128 * 1024

export interface ProposeCurationOptions {
  projectRoot?: string
  decayAfterDays?: number
  now?: number
}

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
    }
  }
  const byFilename = new Map(loaded.map(m => [basename(m.header.filename), m]))
  const proposals: CurationProposal[] = []

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

export async function writeCurationSweep(memoryDir: string, sweep: CurationSweep): Promise<string> {
  const path = proposalsPath(memoryDir)
  mkdirSync(dirname(path), { recursive: true })
  await durableAtomicPublish(path, JSON.stringify(sweep, null, 2))
  return path
}

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
  retired: string[]
  auditCopies: string[]
  survivor?: string
  reason: string
  approvedBy: string
}

export interface ApplyCurationResult {
  applied: CurationReceipt[]
  refused: Array<{ proposal: CurationProposal; reason: string }>
}

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
