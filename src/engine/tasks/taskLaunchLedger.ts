import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getProcessStartInstantAsync, getProcessStartTokenAsync, isProcessAlive } from '../../daemon/control/ownerWatch.js'
import { tokenBinding } from '../../daemon/process-sweep/processSweep.js'
import { publishAtomic } from '../../platform/substrate/fileStore.js'
import { errorMessage, isENOENT } from '../../platform/errors/errors.js'
import { logError } from '../../platform/logs/errorLog.js'
import { endProcessTree } from '../../platform/processes/processGroup.js'
import { getTranscriptPathForSession } from '../../sessions/transcripts/paths.js'
import { loadTaskOutcomes } from './taskOutcomeEnvelope.js'
import { passedOverAs } from '../../platform/errors/passedOver.js'

const TASK_LAUNCH_LEDGER_VERSION = 1
const MAX_LAUNCHES = 200
const MAX_COMMAND_CHARS = 512

type TaskLaunchKind = 'monitor' | 'shell'

interface TaskLaunchRecord {
  v: typeof TASK_LAUNCH_LEDGER_VERSION
  taskId: string
  kind: TaskLaunchKind
  toolUseId: string
  description: string
  command: string
  persistent: boolean
  outputPath: string | null
  pid: number | null
  startToken: string | null
  armedAt: number
}

interface LedgerFile {
  v: typeof TASK_LAUNCH_LEDGER_VERSION
  launches: TaskLaunchRecord[]
}

function taskLaunchesPath(sessionId: string): string {
  const transcript = getTranscriptPathForSession(sessionId)
  return join(dirname(transcript), `${sessionId}.task-launches.json`)
}

const writeChainBySession = new Map<string, Promise<void>>()

function ledgerFailure(sessionId: string, what: string, error: unknown): Error {
  return new Error(`task launch ledger of session ${sessionId}: ${what} — ${error instanceof SyntaxError ? 'the file is not valid JSON' : errorMessage(error)}`)
}

async function loadFileStrict(sessionId: string): Promise<TaskLaunchRecord[]> {
  let raw: string
  try {
    raw = await readFile(taskLaunchesPath(sessionId), 'utf8')
  } catch (error) {
    if (isENOENT(error)) return []
    throw error
  }
  const parsed = JSON.parse(raw) as LedgerFile
  if (parsed?.v !== TASK_LAUNCH_LEDGER_VERSION || !Array.isArray(parsed.launches)) {
    throw new Error(`invalid task launch ledger at ${taskLaunchesPath(sessionId)}`)
  }
  return parsed.launches.filter(row => typeof row?.taskId === 'string' && (row.kind === 'monitor' || row.kind === 'shell'))
}

async function loadFile(sessionId: string): Promise<TaskLaunchRecord[]> {
  try {
    return await loadFileStrict(sessionId)
  } catch (error) {
    logError(ledgerFailure(sessionId, 'it could not be read', error))
    return []
  }
}

function chained(sessionId: string, run: () => Promise<void>): Promise<void> {
  const previous = writeChainBySession.get(sessionId) ?? Promise.resolve()
  const op = previous.then(run, run)
  writeChainBySession.set(
    sessionId,
    op.then(
      () => undefined,
      passedOverAs(undefined),
    ),
  )
  return op
}

async function publish(sessionId: string, launches: TaskLaunchRecord[]): Promise<void> {
  const file: LedgerFile = { v: TASK_LAUNCH_LEDGER_VERSION, launches }
  await publishAtomic(taskLaunchesPath(sessionId), JSON.stringify(file, null, 1))
}

export function recordTaskLaunch(sessionId: string, launch: Omit<TaskLaunchRecord, 'v' | 'startToken'>): Promise<void> {
  return chained(sessionId, async () => {
    try {
      const startToken = launch.pid === null ? null : await getProcessStartInstantAsync(launch.pid)
      const launches = (await loadFileStrict(sessionId)).filter(row => row.taskId !== launch.taskId)
      launches.push({ ...launch, v: TASK_LAUNCH_LEDGER_VERSION, command: launch.command.slice(0, MAX_COMMAND_CHARS), startToken })
      if (launches.length > MAX_LAUNCHES) launches.splice(0, launches.length - MAX_LAUNCHES)
      await publish(sessionId, launches)
    } catch (error) {
      logError(ledgerFailure(sessionId, `the launch of task ${launch.taskId} could not be recorded, so after a crash its process is not reaped on resume`, error))
    }
  })
}

export function settleTaskLaunch(sessionId: string, taskId: string): Promise<void> {
  return chained(sessionId, async () => {
    try {
      const launches = await loadFileStrict(sessionId)
      if (!launches.some(row => row.taskId === taskId)) return
      await publish(
        sessionId,
        launches.filter(row => row.taskId !== taskId),
      )
    } catch (error) {
      logError(ledgerFailure(sessionId, `settlement of task ${taskId} could not be written`, error))
    }
  })
}

async function loadTaskLaunches(sessionId: string): Promise<TaskLaunchRecord[]> {
  await (writeChainBySession.get(sessionId) ?? Promise.resolve())
  return loadFile(sessionId)
}

export type OrphanProcessFate = 'ended' | 'gone' | 'unconfirmed'

export interface OrphanedLaunch {
  record: TaskLaunchRecord
  process: OrphanProcessFate
}

interface LaunchReconcile {
  orphans: OrphanedLaunch[]
  endedPids: number[]
  settledTaskIds: Set<string>
}

export async function reconcileTaskLaunchesOnResume(sessionId: string, liveTaskIds: ReadonlySet<string>): Promise<LaunchReconcile> {
  const launches = await loadTaskLaunches(sessionId)
  const settled = new Set((await loadTaskOutcomes(sessionId)).map(row => row.taskId))
  if (launches.length === 0) return { orphans: [], endedPids: [], settledTaskIds: settled }
  const orphans: OrphanedLaunch[] = []
  const endedPids: number[] = []
  const kept: TaskLaunchRecord[] = []
  for (const record of launches) {
    if (liveTaskIds.has(record.taskId)) {
      kept.push(record)
      continue
    }
    if (settled.has(record.taskId)) continue
    let fate: OrphanProcessFate = 'gone'
    if (record.pid !== null && record.pid > 1 && record.pid !== process.pid && isProcessAlive(record.pid)) {
      fate = 'unconfirmed'
      const observed = await getProcessStartTokenAsync(record.pid, record.startToken)
      if (tokenBinding(record.startToken, observed) === 'bound') {
        const receipt = await endProcessTree(record.pid, 'SIGKILL')
        if (receipt.ended > 0 || !isProcessAlive(record.pid)) {
          fate = 'ended'
          endedPids.push(record.pid)
        }
      }
    }
    orphans.push({ record, process: fate })
  }
  await chained(sessionId, async () => {
    try {
      if (kept.length !== launches.length) await publish(sessionId, kept)
    } catch (error) {
      logError(ledgerFailure(sessionId, 'reconciled launch ledger could not be written', error))
    }
  })
  return { orphans, endedPids, settledTaskIds: settled }
}
