
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
  | { state: 'unavailable'; reason: string; retryable: boolean }

export function runSidecarPath(owner: OwnerKey): string {
  const id = parseOwnerKey(owner)
  const transcript = getTranscriptPathForSession(id.sessionId)
  const dir = path.dirname(transcript)
  if (id.lane === 'main') {
    return path.join(dir, `${id.sessionId}.run.json`)
  }
  return path.join(dir, `${ownerKeyFileStem(owner)}.run.json`)
}

const writeSeqByOwner = new Map<string, number>()

const writeChainByOwner = new Map<string, Promise<void>>()

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
  if (!writeSeqByOwner.has(owner)) {
    try {
      const raw = await readFile(runSidecarPath(owner), 'utf8')
      const prior = (JSON.parse(raw) as { writeSeq?: unknown }).writeSeq
      if (typeof prior === 'number' && Number.isFinite(prior)) {
        writeSeqByOwner.set(owner, prior)
      }
    } catch {
    }
  }
  const seq = (writeSeqByOwner.get(owner) ?? 0) + 1
  writeSeqByOwner.set(owner, seq)
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

export function runRevision(owner: OwnerKey): number {
  return writeSeqByOwner.get(owner) ?? 0
}

export async function loadRunSidecar(owner: OwnerKey): Promise<RunSidecarLoad> {
  const file = runSidecarPath(owner)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (e) {
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
  }
}
