// ============================================================================
//  taskOutcomeEnvelope — the durable, bounded, versioned terminal-outcome
//  record for background tasks (, truth-law 3: evidence belongs
//  to the terminal outcome).
//
//  WHY: AppState.tasks has NO
//  serializer — on /clear, resume, ACP reconnect, or compaction, a
//  background task's terminal facts (exit code, interrupted, timestamps,
//  output linkage) survive only as inert transcript text, and full compact
//  re-injects task_status attachments for local_agent ONLY — a local_bash
//  outcome has no carrier at all once the task is evicted. This module is
//  the ONE durable home for those facts, minted exactly once at the
//  LocalShellTask terminal transition (the same seam that mints
//  verification evidence) and read back by the task tools after the
//  in-memory state is absent.
//
//  Shape discipline: the envelope carries COUNTS and an artifact
//  REFERENCE (the durable tool-results copy — the /tmp tasks file has no
//  retention), never raw output. Storage rides the run-sidecar pattern:
//  one JSON snapshot beside the session transcript, published through
//  durableAtomicPublish on a per-session write chain (torn files and
//  out-of-order snapshots are the recorded failure classes), ring-bounded.
// ============================================================================

import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { durableAtomicPublish } from '../substrate/durablePublish.js'
import { getTranscriptPathForSession } from '../utils/sessionStorage/paths.js'

export const TASK_OUTCOME_ENVELOPE_VERSION = 1

/** Exactly one terminal state per task (truth-law 1). */
export type TaskOutcomeState =
  | 'succeeded'
  | 'failed'
  | 'stopped'
  | 'timed-out'
  | 'killed-policy'
  | 'indeterminate'

export interface TaskOutcomeEnvelope {
  v: typeof TASK_OUTCOME_ENVELOPE_VERSION
  taskId: string
  /** Stable system id ('local_bash', 'monitor' kind rides `kind`). */
  taskType: string
  kind?: string
  /** Bounded — identification, not replay. */
  command: string
  description?: string
  /** A command that never spawned can never read as executed. */
  spawn: 'confirmed' | 'not-started' | 'indeterminate'
  state: TaskOutcomeState
  exitCode?: number
  interrupted: boolean
  /** Set for policy stops: 'deadline' | 'size-watchdog' | 'timeout' | 'user-stop'. */
  terminationReason?: string
  startTime: number
  endTime: number
  durationMs: number
  agentId?: string
  cwd?: string
  output?: {
    totalLines?: number
    totalBytes?: number
    /** The DURABLE artifact (tool-results copy), when one was persisted. */
    artifactPath?: string
  }
}

const MAX_ENVELOPES = 100
const MAX_COMMAND_CHARS = 512

export function taskOutcomesPath(sessionId: string): string {
  const transcript = getTranscriptPathForSession(sessionId)
  return join(dirname(transcript), `${sessionId}.task-outcomes.json`)
}

interface EnvelopeFile {
  v: typeof TASK_OUTCOME_ENVELOPE_VERSION
  envelopes: TaskOutcomeEnvelope[]
}

// Per-session write chain — the run-sidecar lesson: the atomic rename
// prevents a TORN file but not an older snapshot landing after a newer one.
const writeChainBySession = new Map<string, Promise<void>>()
// In-process mirror so mints don't re-read the file on every terminal
// transition (the file stays the durable truth for other processes).
const cacheBySession = new Map<string, TaskOutcomeEnvelope[]>()

async function loadFile(sessionId: string): Promise<TaskOutcomeEnvelope[]> {
  try {
    const raw = await readFile(taskOutcomesPath(sessionId), 'utf8')
    const parsed = JSON.parse(raw) as EnvelopeFile
    if (parsed?.v !== TASK_OUTCOME_ENVELOPE_VERSION || !Array.isArray(parsed.envelopes)) {
      return []
    }
    return parsed.envelopes
  } catch {
    return []
  }
}

/**
 * Mint a task's terminal outcome — exactly once. A second mint for the same
 * taskId is refused (the first terminal outcome stands; truth-law 1: exactly
 * one terminal outcome). Never throws — a failed publish must not break the
 * terminal transition that called it.
 */
export async function recordTaskOutcome(
  sessionId: string,
  envelope: Omit<TaskOutcomeEnvelope, 'v' | 'durationMs'>,
): Promise<void> {
  const chainKey = sessionId
  const previous = writeChainBySession.get(chainKey) ?? Promise.resolve()
  const run = async (): Promise<void> => {
    try {
      let envelopes = cacheBySession.get(sessionId)
      if (!envelopes) {
        envelopes = await loadFile(sessionId)
        cacheBySession.set(sessionId, envelopes)
      }
      if (envelopes.some(e => e.taskId === envelope.taskId)) {
        return // terminal outcome already minted — it stands
      }
      const complete: TaskOutcomeEnvelope = {
        ...envelope,
        v: TASK_OUTCOME_ENVELOPE_VERSION,
        command: envelope.command.slice(0, MAX_COMMAND_CHARS),
        durationMs: Math.max(0, envelope.endTime - envelope.startTime),
      }
      envelopes.push(complete)
      if (envelopes.length > MAX_ENVELOPES) {
        envelopes.splice(0, envelopes.length - MAX_ENVELOPES)
      }
      const file: EnvelopeFile = {
        v: TASK_OUTCOME_ENVELOPE_VERSION,
        envelopes,
      }
      await durableAtomicPublish(
        taskOutcomesPath(sessionId),
        JSON.stringify(file, null, 1),
      )
    } catch {
      // The terminal transition must never fail on the envelope publish.
    }
  }
  const op = previous.then(run, run)
  writeChainBySession.set(
    chainKey,
    op.then(
      () => undefined,
      () => undefined,
    ),
  )
  return op
}

/** Read a session's minted outcomes (schema-tolerant; [] when absent). */
export async function loadTaskOutcomes(
  sessionId: string,
): Promise<TaskOutcomeEnvelope[]> {
  const cached = cacheBySession.get(sessionId)
  if (cached) return cached
  return loadFile(sessionId)
}

/** Look up one task's outcome — the read surface for TaskOutput/TaskStop
 *  after the in-memory task state is absent (clear/resume/reconnect). */
export async function findTaskOutcome(
  sessionId: string,
  taskId: string,
): Promise<TaskOutcomeEnvelope | undefined> {
  return (await loadTaskOutcomes(sessionId)).find(e => e.taskId === taskId)
}

/** Derive the envelope terminal state from a settled shell result (the
 *  LocalShellTask mint seam's vocabulary). */
export function shellOutcomeState(args: {
  code: number
  interrupted: boolean
  wasKilled: boolean
  stderr?: string
}): { state: TaskOutcomeState; terminationReason?: string } {
  if (args.wasKilled) return { state: 'stopped', terminationReason: 'user-stop' }
  const stderr = args.stderr ?? ''
  if (stderr.includes('absolute deadline elapsed')) {
    return { state: 'killed-policy', terminationReason: 'deadline' }
  }
  if (stderr.includes('output file exceeded')) {
    return { state: 'killed-policy', terminationReason: 'size-watchdog' }
  }
  if (stderr.includes('Command timed out after')) {
    return { state: 'timed-out', terminationReason: 'timeout' }
  }
  if (args.interrupted) return { state: 'stopped', terminationReason: 'user-stop' }
  return args.code === 0 ? { state: 'succeeded' } : { state: 'failed' }
}
