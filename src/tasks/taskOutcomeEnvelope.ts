
import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { durableAtomicPublish } from '../substrate/durablePublish.js'
import { getTranscriptPathForSession } from '../utils/sessionStorage/paths.js'

export const TASK_OUTCOME_ENVELOPE_VERSION = 1

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
  taskType: string
  kind?: string
  command: string
  description?: string
  spawn: 'confirmed' | 'not-started' | 'indeterminate'
  state: TaskOutcomeState
  exitCode?: number
  interrupted: boolean
  terminationReason?: string
  startTime: number
  endTime: number
  durationMs: number
  agentId?: string
  cwd?: string
  output?: {
    totalLines?: number
    totalBytes?: number
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

const writeChainBySession = new Map<string, Promise<void>>()
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
        return
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

export async function loadTaskOutcomes(
  sessionId: string,
): Promise<TaskOutcomeEnvelope[]> {
  const cached = cacheBySession.get(sessionId)
  if (cached) return cached
  return loadFile(sessionId)
}

export async function findTaskOutcome(
  sessionId: string,
  taskId: string,
): Promise<TaskOutcomeEnvelope | undefined> {
  return (await loadTaskOutcomes(sessionId)).find(e => e.taskId === taskId)
}

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
