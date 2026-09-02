/* ============================================================================
   THEMIS audit chain — a TRUE prev-hash tamper-evident log.

   Adapted from arXiv:2606.26924 §"hash-chained audit log", deliberately
   EXCEEDING it: the paper's pseudocode stamps each JSONL line with
   sha256(own content) only, which detects edits but NOT deletion, reordering,
   or truncation. Here every row folds the PREVIOUS row's hash into its own
   (`prev` → `hash = sha256(canonical(row∖hash))` where canonical includes
   `prev`), and a HEAD SIDECAR persists the latest {seq, hash} — so all four
   tamper classes are detectable:

     edited     — row i's hash no longer matches its own content
     broken     — row i's content is self-consistent but its `prev` does not
                  match row i−1's hash (a deletion or reorder upstream)
     truncated  — the chain verifies but the head sidecar records a later seq
     head-mismatch — same seq, different hash (tail swapped wholesale)

   MULTI-WRITER HONESTY (deviation from the paper, ledgered): a prev-hash
   chain has exactly one legal appender. Mercury has several concurrent
   processes (session, daemon, workers), so each process boot appends to its
   OWN chain file `audit-<pid>-<bootTs>.jsonl` and the verifier sweeps the
   directory. A single shared file would interleave and corrupt the chain —
   per-process chains keep the tamper-evidence claim true instead of
   decorative.

   Write posture (the evolutionLedger idiom): best-effort, never throws on
   the hot path, O_APPEND single write per row, per-file promise chain
   against in-process interleaving, clamped free-text fields. The head
   sidecar is written atomically (tmp+rename) AFTER the append — a crash
   between the two leaves the head one row behind, which the verifier
   reports as ok-with-note (`head-behind`), never as tampering.

   GATING: rows are only written while themisActive(); off ⇒ no dir, no file.
   Reading/verifying is gate-independent (the /ledger doctrine: past records
   stay inspectable after opt-out).
   ============================================================================ */

import { projectConfigCandidates } from '../../utils/projectConfig.js'
import { adoptiveProjectPath } from '../../utils/projectStoreAdoption.js'
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { themisActive } from './level.js'
import { logForDebugging } from '../../utils/debug.js'
import { durableAtomicPublish } from '../durablePublish.js'

export interface ThemisAuditRow {
  ts: string
  /** Monotonic per chain file, starting at 1. */
  seq: number
  /** Who acted: 'main' | an agent type | 'daemon' | 'boot' | 'cli'. */
  actor: string
  /** Closed-ish verb vocabulary, e.g. 'blocklist-hit', 'blocklist-deny',
   *  'capability-deny', 'lockfile-verify', 'drift-check', 'phase-transition',
   *  'menu-env-applied', 'approve'. */
  action: string
  cwd: string
  /** Clamped free text — pattern ids, paths, verdicts. Never secrets. */
  details?: string
  /** Previous row's hash; 'genesis' for row 1. */
  prev: string
  /** sha256 hex over the canonical serialization of the row minus `hash`. */
  hash: string
}

const CAP = { actor: 60, action: 60, cwd: 300, details: 500 } as const
const clamp = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export const GENESIS = 'genesis'

/** Canonical serialization the hash covers — fixed key order, `hash` excluded.
 *  Deterministic by construction (no object-key iteration). */
export function canonicalRowBody(row: Omit<ThemisAuditRow, 'hash'>): string {
  return JSON.stringify([row.ts, row.seq, row.actor, row.action, row.cwd, row.details ?? '', row.prev])
}

export function hashRowBody(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

export function themisDir(cwd: string = process.cwd()): string {
  // Sticky at the store root: an existing home's chains stay
  // in place (nothing hash-linked ever moves — a sidecar must never be
  // separated from its .jsonl); a fresh project chains under .mercury.
  return adoptiveProjectPath(cwd, 'themis')
}

/** EVERY existing themis home for a cwd — verification must MERGE, never
 *  stick: a project with chains in `.claude/themis` that later gains
 *  `.mercury/themis` must verify BOTH (evidence loss reported as a pass is
 *  the exact failure mode this subsystem exists to prevent). */
export function themisDirs(cwd: string = process.cwd()): string[] {
  const existing = projectConfigCandidates(cwd, 'themis')
  return existing.length > 0 ? existing : [themisDir(cwd)]
}

// ── per-process chain state ─────────────────────────────────────────────────
interface ChainState {
  file: string
  headFile: string
  seq: number
  prev: string
  queue: Promise<void>
  /** The chain's dir is ensured ONCE per state — after that, a vanished dir
   *  is the LOSS EVENT (worktree-exit class): the append ENOENTs and the
   *  heal re-boots at the live cwd. A per-append recursive mkdir would
   *  silently RESURRECT a deleted home and mask the loss. */
  dirEnsured: boolean
}
let chain: ChainState | null = null
/** Monotonic per-process epoch folded into the filename so a re-boot (test
 *  reset, dir-vanished self-heal) can never collide with a prior chain file
 *  even inside the same millisecond. */
let bootEpoch = 0

function bootChainState(): ChainState {
  if (chain) return chain
  const boot = `${Date.now().toString(36)}-${(++bootEpoch).toString(36)}`
  // Resolve ONCE into the ChainState — the appender mkdirs dirname(st.file),
  // so a home appearing mid-process can never split the chain across homes.
  const dir = themisDir()
  const file = join(dir, `audit-${process.pid}-${boot}.jsonl`)
  chain = {
    file,
    headFile: `${file}.head`,
    seq: 0,
    prev: GENESIS,
    queue: Promise.resolve(),
    dirEnsured: false,
  }
  return chain
}

/** Test seam: reset the in-process chain so a proof can start a fresh file. */
export function resetAuditChainForTests(): void {
  chain = null
}

/**
 * Append one audit row to this process's chain. Fire-and-forget safe: never
 * throws, never blocks the caller beyond promise creation; serialized per
 * process so seq/prev stay coherent. No-op (and no dir creation) when THEMIS
 * is off.
 */
export function appendAuditRow(input: {
  actor: string
  action: string
  details?: string
  cwd?: string
}): Promise<void> {
  if (!themisActive()) return Promise.resolve()
  const st = bootChainState()
  const run = async (): Promise<void> => {
    try {
      if (!st.dirEnsured) {
        await mkdir(dirname(st.file), { recursive: true })
        st.dirEnsured = true
      }
      const body: Omit<ThemisAuditRow, 'hash'> = {
        ts: new Date().toISOString(),
        seq: st.seq + 1,
        actor: clamp(String(input.actor || 'main'), CAP.actor),
        action: clamp(String(input.action || 'event'), CAP.action),
        cwd: clamp(String(input.cwd ?? process.cwd()), CAP.cwd),
        details: input.details ? clamp(String(input.details), CAP.details) : undefined,
        prev: st.prev,
      }
      const hash = hashRowBody(canonicalRowBody(body))
      const row: ThemisAuditRow = { ...body, hash }
      await appendFile(st.file, JSON.stringify(row) + '\n', { encoding: 'utf8' })
      st.seq = body.seq
      st.prev = hash
      // Head sidecar: the one durable primitive — no torn head, no shared tmp.
      await durableAtomicPublish(st.headFile, JSON.stringify({ seq: st.seq, hash: st.prev }))
    } catch (e) {
      logForDebugging(`themis audit append failed: ${String(e)}`)
      // Dir-vanished self-heal: the chain file is pinned to the cwd of its
      // first append; a worktree exit can DELETE that directory, after which
      // every append would fail ENOENT forever — audit rows silently lost for
      // the rest of the process. Kill only OUR epoch (identity-guarded so a
      // straggler queued on a dead epoch can never clobber a healed one); the
      // NEXT append re-boots a fresh chain at the live cwd. Rows already
      // queued on this epoch still fail (each logs) — the loss window is the
      // in-flight queue, not the rest of the session.
      const code = (e as NodeJS.ErrnoException | null)?.code
      if ((code === 'ENOENT' || code === 'ENOTDIR') && chain === st) {
        chain = null
        logForDebugging('themis audit chain re-booted: parent dir vanished; next row starts a fresh chain')
      }
    }
  }
  st.queue = st.queue.then(run, run)
  return st.queue
}

// ── verification (pure read; gate-independent) ──────────────────────────────
export type ChainVerdict =
  | { ok: true; rows: number; note?: 'head-behind' | 'no-head' }
  | {
      ok: false
      rows: number
      tamperedAt: number // 1-based row index (or rows+1 for tail claims)
      kind: 'edited' | 'broken' | 'truncated' | 'head-mismatch' | 'malformed'
      detail: string
    }

export async function verifyAuditChainFile(file: string): Promise<ChainVerdict> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { ok: false, rows: 0, tamperedAt: 0, kind: 'malformed', detail: 'unreadable file' }
  }
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  let prev = GENESIS
  let lastSeq = 0
  let lastHash = GENESIS
  for (let i = 0; i < lines.length; i++) {
    let row: ThemisAuditRow
    try {
      row = JSON.parse(lines[i]!) as ThemisAuditRow
    } catch {
      return { ok: false, rows: lines.length, tamperedAt: i + 1, kind: 'malformed', detail: 'unparseable row' }
    }
    const body: Omit<ThemisAuditRow, 'hash'> = {
      ts: row.ts, seq: row.seq, actor: row.actor, action: row.action,
      cwd: row.cwd, details: row.details, prev: row.prev,
    }
    const expect = hashRowBody(canonicalRowBody(body))
    if (expect !== row.hash) {
      // The row's own content and its stamp disagree — the row was EDITED.
      return { ok: false, rows: lines.length, tamperedAt: i + 1, kind: 'edited', detail: `row ${i + 1} hash mismatch` }
    }
    if (row.prev !== prev) {
      // Self-consistent row whose lineage doesn't meet the chain: a row
      // upstream was deleted or the order was changed.
      return { ok: false, rows: lines.length, tamperedAt: i + 1, kind: 'broken', detail: `row ${i + 1} prev-link broken (deletion/reorder upstream)` }
    }
    if (row.seq !== lastSeq + 1) {
      return { ok: false, rows: lines.length, tamperedAt: i + 1, kind: 'broken', detail: `row ${i + 1} seq gap (${lastSeq} → ${row.seq})` }
    }
    prev = row.hash
    lastSeq = row.seq
    lastHash = row.hash
  }
  // Chain internally consistent — now reconcile against the persisted head.
  let head: { seq: number; hash: string } | null = null
  try {
    head = JSON.parse(await readFile(`${file}.head`, 'utf8')) as { seq: number; hash: string }
  } catch {
    head = null
  }
  if (!head) {
    return { ok: true, rows: lines.length, note: 'no-head' }
  }
  if (head.seq > lastSeq) {
    return { ok: false, rows: lines.length, tamperedAt: lines.length + 1, kind: 'truncated', detail: `head records seq ${head.seq}, file ends at ${lastSeq} — tail removed` }
  }
  if (head.seq === lastSeq && head.hash !== lastHash) {
    return { ok: false, rows: lines.length, tamperedAt: lines.length, kind: 'head-mismatch', detail: 'head hash differs at equal seq — tail swapped' }
  }
  if (head.seq < lastSeq) {
    // Crash window: append landed, head write didn't. Not tampering.
    return { ok: true, rows: lines.length, note: 'head-behind' }
  }
  return { ok: true, rows: lines.length }
}

/** Sweep every chain file across EVERY existing themis home (merge — see
 *  themisDirs). An explicit dir sweeps exactly that dir. Missing ⇒ zero
 *  chains, ok. */
export async function verifyAllChains(
  dir?: string,
): Promise<{ ok: boolean; chains: Array<{ file: string; verdict: ChainVerdict }> }> {
  const dirs = dir !== undefined ? [dir] : themisDirs()
  const merged: { ok: boolean; chains: Array<{ file: string; verdict: ChainVerdict }> } = { ok: true, chains: [] }
  for (const d of dirs) {
    const one = await verifyChainsInDir(d)
    merged.ok = merged.ok && one.ok
    merged.chains.push(...one.chains)
  }
  return merged
}

async function verifyChainsInDir(
  dir: string,
): Promise<{ ok: boolean; chains: Array<{ file: string; verdict: ChainVerdict }> }> {
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter(n => /^audit-.*\.jsonl$/.test(n))
  } catch (e) {
    // Missing dir = nothing ever recorded (ok). Any OTHER read failure
    // (EACCES, ENOTDIR, …) is unreadable trust state — surfacing it as
    // "zero chains, all fine" would be the silent-disable direction.
    if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { ok: true, chains: [] }
    }
    return {
      ok: false,
      chains: [{
        file: dir,
        verdict: { ok: false, rows: 0, tamperedAt: 0, kind: 'malformed', detail: `themis dir unreadable: ${String((e as NodeJS.ErrnoException | null)?.code ?? e)}` },
      }],
    }
  }
  const chains: Array<{ file: string; verdict: ChainVerdict }> = []
  for (const n of names.sort()) {
    const file = join(dir, n)
    chains.push({ file, verdict: await verifyAuditChainFile(file) })
  }
  return { ok: chains.every(c => c.verdict.ok), chains }
}
