/* ============================================================================
   THEMIS tracked change mission — the concrete optional daily use case.

   A MISSION is a small durable contract for a bounded
   multi-file change, composed from existing owners:

     goal text        → the operator's words (the session goal is ephemeral;
                        the mission is its durable projection when tracked)
     expected paths   → the project-intel changed-path truth seeds suggestions;
                        the operator amends
     checks           → verify-evidence commands (bun run verify:fast, suite
                        runners) — completion demands FRESH evidence
                        (EvidenceRecord.ok at the CURRENT tree digest)
     drift            → scanDiff-style set arithmetic at the SAME tool gate
                        THEMIS already owns; ONE warning per path, never a
                        nag stream

   Level semantics (truthful): off ⇒ no mission behavior, no files.
   warn ⇒ drift is RECORDED + surfaced, never blocks. enforce ⇒ an
   unexpected-path Edit/Write is refused with add-to-contract/inspect
   directions — ONLY while a mission is active; no mission ⇒ no new
   restriction beyond the standing blocklist.

   Store: <themisDir>/missions/<id>.json + current.json pointer (ONE active
   mission at a time — the v1 contract), durableAtomicPublish, per-cwd like
   the rest of the THEMIS store. Resume = re-read from disk; compaction
   survives by construction.
   ============================================================================ */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../durablePublish.js'
import { appendAuditRow, themisDir } from './auditChain.js'
import { themisLevel } from './level.js'
import {
  computeWorkingTreeDigest,
  evidenceRecordsFor,
  verificationSummary,
} from '../../utils/verification/verificationState.js'

export interface MissionCriterion {
  id: string
  text: string
  /** Workspace-relative path prefixes expected to implement this criterion. */
  paths: string[]
  /** Verification commands whose FRESH evidence completes the criterion. */
  checks: string[]
}

export interface MissionWarning {
  path: string
  tool: string
  at: string
  resolution?: 'added-to-contract' | 'inspected'
}

export interface MissionContract {
  version: 1
  id: string
  title: string
  goalText: string
  criteria: MissionCriterion[]
  /** Extra expected path prefixes beyond the criteria (docs, tests, bench). */
  expectedPaths: string[]
  createdAt: string
  baselineDigest: string | null
  phase: 'active' | 'complete' | 'abandoned'
  warnings: MissionWarning[]
  completedAt?: string
  receipt?: MissionReceipt
}

export interface MissionReceipt {
  completedAt: string
  treeDigest: string | null
  criteria: Array<{ id: string; text: string; implementedBy: string[]; evidence: string[] }>
  warningsResolved: number
  warningsOpen: number
}

export type MissionCompletionVerdict =
  | { ok: true; receipt: MissionReceipt }
  | { ok: false; remains: string[] }

function missionsDir(cwd: string): string {
  return join(themisDir(cwd), 'missions')
}
function currentPath(cwd: string): string {
  return join(missionsDir(cwd), 'current.json')
}

/** The active mission, or null (off level ⇒ always null — zero fs). */
export function activeMission(cwd: string = process.cwd()): MissionContract | null {
  if (themisLevel() === 'off') return null
  try {
    const cur = JSON.parse(readFileSync(currentPath(cwd), 'utf8')) as { id?: string }
    if (!cur?.id) return null
    const m = JSON.parse(readFileSync(join(missionsDir(cwd), `${cur.id}.json`), 'utf8')) as MissionContract
    return m?.version === 1 && m.phase === 'active' ? m : null
  } catch {
    return null
  }
}

function saveMission(cwd: string, m: MissionContract): void {
  mkdirSync(missionsDir(cwd), { recursive: true })
  durableAtomicPublishSync(join(missionsDir(cwd), `${m.id}.json`), JSON.stringify(m, null, 2))
}

export function startMission(
  input: { title: string; goalText?: string; criteria?: Array<{ text: string; paths?: string[]; checks?: string[] }>; expectedPaths?: string[] },
  cwd: string = process.cwd(),
): { ok: true; mission: MissionContract } | { ok: false; reason: string } {
  const level = themisLevel()
  if (level === 'off') return { ok: false, reason: 'THEMIS is off (it is on by default — this session set MERCURY_THEMIS=off). Unset it, or set warn|enforce, to track a change mission' }
  if (activeMission(cwd)) return { ok: false, reason: 'a mission is already active — /mission done or /mission drop first' }
  const title = String(input.title ?? '').trim()
  if (!title) return { ok: false, reason: 'a mission needs a title' }
  const now = new Date().toISOString()
  const id = `m-${now.slice(0, 10)}-${Math.abs(hash32(title + now)).toString(36).slice(0, 6)}`
  const criteria: MissionCriterion[] = (input.criteria ?? []).map((c, i) => ({
    id: `c${i + 1}`,
    text: String(c.text).trim(),
    paths: (c.paths ?? []).map(normalizeRel),
    checks: c.checks ?? [],
  }))
  const mission: MissionContract = {
    version: 1,
    id,
    title,
    goalText: String(input.goalText ?? '').trim(),
    criteria,
    expectedPaths: (input.expectedPaths ?? []).map(normalizeRel),
    createdAt: now,
    baselineDigest: computeWorkingTreeDigest(cwd),
    phase: 'active',
    warnings: [],
  }
  saveMission(cwd, mission)
  durableAtomicPublishSync(currentPath(cwd), JSON.stringify({ id }))
  void appendAuditRow({ actor: 'main', action: 'mission-start', details: `${id} "${title}" criteria=${criteria.length}` })
  return { ok: true, mission }
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h | 0
}

function normalizeRel(p: string): string {
  return String(p).trim().replace(/^\.\//, '').replace(/\/+$/, '')
}

/** Is a workspace-relative path inside the mission's expected sets? */
export function pathExpected(m: MissionContract, rel: string): boolean {
  const p = normalizeRel(rel)
  const inSet = (prefix: string): boolean => p === prefix || p.startsWith(prefix + '/')
  if (m.expectedPaths.some(inSet)) return true
  return m.criteria.some(c => c.paths.some(inSet))
}

/**
 * The gate consult (called from themisToolGate for Edit/Write-class tools).
 * Records at most ONE warning per path per mission; returns what the caller
 * should do at the CURRENT level. Never throws.
 */
export function missionDriftConsult(
  toolName: string,
  rel: string,
  cwd: string = process.cwd(),
): { drift: false } | { drift: true; firstSeen: boolean; deny: boolean; mission: MissionContract } {
  try {
    const m = activeMission(cwd)
    if (!m) return { drift: false }
    if (pathExpected(m, rel)) return { drift: false }
    const level = themisLevel()
    const existing = m.warnings.find(w => w.path === normalizeRel(rel))
    const firstSeen = !existing
    if (firstSeen) {
      m.warnings.push({ path: normalizeRel(rel), tool: toolName, at: new Date().toISOString() })
      saveMission(cwd, m)
      void appendAuditRow({ actor: 'main', action: 'mission-drift', details: `${m.id} unexpected path ${normalizeRel(rel)} via ${toolName}` })
    }
    return { drift: true, firstSeen, deny: level === 'enforce', mission: m }
  } catch {
    return { drift: false }
  }
}

/** Amend the active mission with a criterion (amendable while active). */
export function addCriterion(
  input: { text: string; paths?: string[]; checks?: string[] },
  cwd: string = process.cwd(),
): { ok: true; id: string } | { ok: false; reason: string } {
  const m = activeMission(cwd)
  if (!m) return { ok: false, reason: 'no active mission' }
  const text = String(input.text ?? '').trim()
  if (!text) return { ok: false, reason: 'a criterion needs text' }
  const id = `c${m.criteria.length + 1}`
  m.criteria.push({ id, text, paths: (input.paths ?? []).map(normalizeRel).filter(Boolean), checks: (input.checks ?? []).filter(Boolean) })
  saveMission(cwd, m)
  void appendAuditRow({ actor: 'main', action: 'mission-amend', details: `${m.id} +${id} "${text.slice(0, 60)}"` })
  return { ok: true, id }
}

/** add-to-contract: the drift path becomes expected; its warning resolves. */
export function addPathToMission(rel: string, cwd: string = process.cwd()): { ok: boolean; reason?: string } {
  const m = activeMission(cwd)
  if (!m) return { ok: false, reason: 'no active mission' }
  const p = normalizeRel(rel)
  if (!pathExpected(m, p)) m.expectedPaths.push(p)
  for (const w of m.warnings) if (w.path === p && !w.resolution) w.resolution = 'added-to-contract'
  saveMission(cwd, m)
  void appendAuditRow({ actor: 'main', action: 'mission-amend', details: `${m.id} + ${p}` })
  return { ok: true }
}

export function markWarningInspected(rel: string, cwd: string = process.cwd()): boolean {
  const m = activeMission(cwd)
  if (!m) return false
  let hit = false
  for (const w of m.warnings) {
    if (w.path === normalizeRel(rel) && !w.resolution) {
      w.resolution = 'inspected'
      hit = true
    }
  }
  if (hit) saveMission(cwd, m)
  return hit
}

/** Changed paths since the mission started (the project-intel git truth). */
function changedPaths(cwd: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { windowsHide: true, encoding: 'utf8', timeout: 5000 })
    return out
      .split('\n')
      .map(l => l.slice(3).trim())
      .filter(Boolean)
      .map(normalizeRel)
  } catch {
    return []
  }
}

/**
 * Completion gate: every criterion must name ≥1 implementing changed
 * path AND carry FRESH ok evidence (an EvidenceRecord whose command matches
 * one of its checks, ok, at the CURRENT tree digest). Anything short returns
 * the exact remains — never a silent success.
 */
export function completeMission(cwd: string = process.cwd()): MissionCompletionVerdict {
  const m = activeMission(cwd)
  if (!m) return { ok: false, remains: ['no active mission'] }
  const remains: string[] = []
  const changed = changedPaths(cwd)
  const digest = computeWorkingTreeDigest(cwd)
  // Hydrate the persisted evidence store for this cwd (evidenceRecordsFor
  // peeks in-memory only — a resumed session must see disk records).
  verificationSummary(cwd, { skipDigest: true })
  const evidence = evidenceRecordsFor()
  const fresh = evidence.filter(e => e.ok && (digest === null || e.treeDigest === digest))
  const receiptRows: MissionReceipt['criteria'] = []
  for (const c of m.criteria) {
    const implementedBy = changed.filter(p => c.paths.some(prefix => p === prefix || p.startsWith(prefix + '/')))
    if (implementedBy.length === 0) remains.push(`${c.id} "${c.text}": no implementing change under ${c.paths.join(', ') || '(no paths declared — /mission addpath first)'}`)
    const evHits = fresh.filter(e => c.checks.some(k => e.command.includes(k))).map(e => `${e.command} @ ${e.treeDigest?.slice(0, 8) ?? 'no-digest'}`)
    if (c.checks.length > 0 && evHits.length === 0) {
      remains.push(`${c.id} "${c.text}": no FRESH passing evidence for ${c.checks.join(' / ')} (run the check, then /mission done)`)
    }
    receiptRows.push({ id: c.id, text: c.text, implementedBy, evidence: evHits })
  }
  const openWarnings = m.warnings.filter(w => !w.resolution)
  if (openWarnings.length > 0) {
    remains.push(`${openWarnings.length} unexpected-path warning(s) unresolved: ${openWarnings.map(w => w.path).slice(0, 4).join(', ')} — /mission add <path> or /mission inspected <path>`)
  }
  if (remains.length > 0) return { ok: false, remains }
  const receipt: MissionReceipt = {
    completedAt: new Date().toISOString(),
    treeDigest: digest,
    criteria: receiptRows,
    warningsResolved: m.warnings.length,
    warningsOpen: 0,
  }
  m.phase = 'complete'
  m.completedAt = receipt.completedAt
  m.receipt = receipt
  saveMission(cwd, m)
  durableAtomicPublishSync(currentPath(cwd), JSON.stringify({ id: null }))
  void appendAuditRow({ actor: 'main', action: 'mission-complete', details: `${m.id} criteria=${m.criteria.length} warnings=${m.warnings.length}` })
  return { ok: true, receipt }
}

export function abandonMission(reason: string, cwd: string = process.cwd()): boolean {
  const m = activeMission(cwd)
  if (!m) return false
  m.phase = 'abandoned'
  saveMission(cwd, m)
  durableAtomicPublishSync(currentPath(cwd), JSON.stringify({ id: null }))
  void appendAuditRow({ actor: 'main', action: 'mission-abandon', details: `${m.id} ${reason.slice(0, 80)}` })
  return true
}

/** One-line status for the doctor and /themis surfaces. */
export function missionStatusLine(cwd: string = process.cwd()): string | null {
  const m = activeMission(cwd)
  if (!m) return null
  const open = m.warnings.filter(w => !w.resolution).length
  return `mission "${m.title}" (${m.id}): ${m.criteria.length} criteria · ${m.warnings.length} drift warning(s)${open ? ` (${open} open)` : ''} · started ${m.createdAt.slice(0, 16)}`
}
