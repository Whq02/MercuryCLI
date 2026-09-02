// ============================================================================
//  runSidecar — schema-versioned atomic persistence for RunSnapshots
//
//
//  The sidecar rides beside the session transcript
//  (<transcript-dir>/<sessionId>.run.json for the main lane; agent lanes get
//  a lane-stamped stem) so the run's durability shares the transcript's
//  identity. Contract:
//    · atomic publication (tmp + rename) — a torn write can never be read;
//    · schema-versioned — a NEWER schema loads as an explicit recoverable
//      state, never a silently-misread run;
//    · corrupt bytes load as recoverable, never a fabricated completed run.
//  IO is deliberately tiny and synchronous-free; the coordinator owns
//  coalescing and flush timing.
// ============================================================================

import { readFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { classifyReadFailure } from '../../substrate/sourceState.js'
import { getTranscriptPathForSession } from '../../utils/sessionStorage/paths.js'
import { ownerKeyFileStem, parseOwnerKey, type OwnerKey } from './ownerKey.js'
import { RUN_SCHEMA_VERSION, type RunSnapshot } from './runKernel.js'

export type RunSidecarLoad =
  | { state: 'none' }
  | { state: 'loaded'; snapshot: RunSnapshot }
  | { state: 'recoverable'; reason: string; raw?: string }
  /** The sidecar could not be OBSERVED at all — distinct from `none` (there is
   *  no run) and from `recoverable` (bytes arrived and made no sense).
   *  defect H: this would otherwise collapse into `none`. */
  | { state: 'unavailable'; reason: string; retryable: boolean }

/** The sidecar path for an owner (beside the session transcript). */
export function runSidecarPath(owner: OwnerKey): string {
  const id = parseOwnerKey(owner)
  const transcript = getTranscriptPathForSession(id.sessionId)
  const dir = path.dirname(transcript)
  if (id.lane === 'main') {
    return path.join(dir, `${id.sessionId}.run.json`)
  }
  return path.join(dir, `${ownerKeyFileStem(owner)}.run.json`)
}

// Per-owner monotonic write sequence (operation/revision metadata on the
// sidecar). Single-writer per owner (the owning session), so an
// in-memory counter seeded from the loaded sidecar is exact; a fresh process
// resumes the count from disk on its first load.
const writeSeqByOwner = new Map<string, number>()

/**
 * Per-owner write chain. The sequence number is allocated
 * in memory and the bytes are published through durableAtomicPublish, which
 * has no per-path serialization: the atomic rename prevents a TORN file, but
 * it cannot stop an older snapshot landing after a newer one, so sequence N
 * could overwrite N+1 on disk. Serializing per owner makes allocation and
 * publication one indivisible step for every caller — the run coordinator's
 * persistence actor already orders its own commits, but this owner is public
 * and must be safe for anyone who calls it.
 *
 * The chain never rejects: a failed write must not poison the next one.
 */
const writeChainByOwner = new Map<string, Promise<void>>()

/** Who wrote a generation. Stamped now so can fence on (epoch,
 *  revision) at the commit boundary without changing the persisted shape a
 *  second time. Absent for callers outside the persistence actor. */
export interface SidecarWriter {
  epoch: number
  writerId: string
}

export async function saveRunSidecar(
  owner: OwnerKey,
  snapshot: RunSnapshot,
  writer?: SidecarWriter,
): Promise<void> {
  const previous = writeChainByOwner.get(owner) ?? Promise.resolve()
  const run = (): Promise<void> => publishRunSidecar(owner, snapshot, writer)
  const op = previous.then(run, run)
  writeChainByOwner.set(
    owner,
    op.then(
      () => undefined,
      () => undefined,
    ),
  )
  return op
}

async function publishRunSidecar(
  owner: OwnerKey,
  snapshot: RunSnapshot,
  writer?: SidecarWriter,
): Promise<void> {
  // MONOTONICITY BELT: a process whose FIRST write for
  // this owner happens without a prior load (a headless boot that never
  // reconciled) would restart the sequence at 1 and silently regress the
  // on-disk receipt's revision metadata. Seed from the existing sidecar
  // before the first write; absent/unreadable seeds 0 exactly as before.
  if (!writeSeqByOwner.has(owner)) {
    try {
      const raw = await readFile(runSidecarPath(owner), 'utf8')
      const prior = (JSON.parse(raw) as { writeSeq?: unknown }).writeSeq
      if (typeof prior === 'number' && Number.isFinite(prior)) {
        writeSeqByOwner.set(owner, prior)
      }
    } catch {
      /* no existing sidecar — a fresh sequence is correct */
    }
  }
  const seq = (writeSeqByOwner.get(owner) ?? 0) + 1
  writeSeqByOwner.set(owner, seq)
  // The shared durable primitive: collision-free temp (two overlapping saves
  // for one owner would otherwise share a pid-only temp path — FC2), fsync barriers,
  // typed failure phases.
  await durableAtomicPublish(
    runSidecarPath(owner),
    JSON.stringify(
      {
        schema: RUN_SCHEMA_VERSION,
        writeSeq: seq,
        ...(writer && { writerEpoch: writer.epoch, writerId: writer.writerId }),
        operationId: randomUUID(),
        committedAt: new Date().toISOString(),
        snapshot,
      },
      null,
      2,
    ),
  )
}

/**
 * The owner's durable RUN REVISION — the write sequence last observed by this
 * process, either allocated by a save here or seeded from disk by a load.
 * 0 means "no durable write observed yet", which is distinct from "no run".
 *
 * client-protocol: this is the number every read surface must agree on.
 * The TUI and an ACP client looking at the same owner must not disagree about
 * WHICH revision of the run they are describing, or the editor quietly renders
 * a different state from the terminal beside it. Monotonic per owner, and
 * process-local in the same sense the writer epoch is — compare it against
 * another surface in the same process, never across machines.
 */
export function runRevision(owner: OwnerKey): number {
  return writeSeqByOwner.get(owner) ?? 0
}

export async function loadRunSidecar(owner: OwnerKey): Promise<RunSidecarLoad> {
  const file = runSidecarPath(owner)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (e) {
    // ENOENT is the ONLY code that means "there is no run here". Every other
    // one — EISDIR for a directory at the path, EACCES, EIO — means the
    // sidecar could not be observed, and answering "no run exists" to that is
    // defect H: a confident false statement about durable work that may well
    // be on disk.
    const cls = classifyReadFailure(e)
    if (cls.state === 'empty') return { state: 'none' }
    return { state: 'unavailable', reason: cls.reason, retryable: cls.retryable }
  }
  let parsed: { schema?: number; writeSeq?: number; snapshot?: RunSnapshot }
  try {
    parsed = JSON.parse(raw) as { schema?: number; writeSeq?: number; snapshot?: RunSnapshot }
  } catch {
    return { state: 'recoverable', reason: 'sidecar is not valid JSON (torn or corrupt write)', raw }
  }
  // Resume the per-owner write sequence from the loaded sidecar so a fresh
  // process keeps the revision metadata monotonic.
  if (typeof parsed.writeSeq === 'number' && Number.isFinite(parsed.writeSeq)) {
    if ((writeSeqByOwner.get(owner) ?? 0) < parsed.writeSeq) {
      writeSeqByOwner.set(owner, parsed.writeSeq)
    }
  }
  if (typeof parsed.schema !== 'number' || parsed.schema > RUN_SCHEMA_VERSION) {
    return {
      state: 'recoverable',
      reason: `sidecar schema ${String(parsed.schema)} is newer than this build (${RUN_SCHEMA_VERSION})`,
    }
  }
  const snap = parsed.snapshot
  if (
    !snap ||
    typeof snap.runId !== 'string' ||
    typeof snap.objective !== 'string' ||
    typeof snap.lifecycle !== 'string' ||
    !Array.isArray(snap.deliverables) ||
    !Array.isArray(snap.recentEvents)
  ) {
    return { state: 'recoverable', reason: 'sidecar snapshot is structurally invalid' }
  }
  return { state: 'loaded', snapshot: snap }
}

export async function deleteRunSidecar(owner: OwnerKey): Promise<void> {
  try {
    await unlink(runSidecarPath(owner))
  } catch {
    /* absent is fine */
  }
}
