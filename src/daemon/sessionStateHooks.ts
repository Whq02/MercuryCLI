import { concourseRecordState } from '../services/concourse/concourseSnapshot.js'
import { SESSION_BOARD_STATES, SESSION_STATE_HOOK_STATES } from '../utils/hooks/contract.js'
import { fireHooks } from '../utils/hooks/fire.js'
import { logForDebugging } from '../utils/debug.js'
import type { ConcourseWorkerRecordV1 } from './concourseWorkers.js'
import { isProcessAlive } from './ownerWatch.js'

type BoardState = ReturnType<typeof concourseRecordState>

const lastStates = new Map<string, BoardState>()
const askingSessions = new Set<string>()

function hookStateOf(state: BoardState): (typeof SESSION_STATE_HOOK_STATES)[number] | undefined {
  return (SESSION_STATE_HOOK_STATES as readonly string[]).includes(state) ? (state as (typeof SESSION_STATE_HOOK_STATES)[number]) : undefined
}

function boardStateOf(state: BoardState): (typeof SESSION_BOARD_STATES)[number] | undefined {
  return (SESSION_BOARD_STATES as readonly string[]).includes(state) ? (state as (typeof SESSION_BOARD_STATES)[number]) : undefined
}

function detailOf(rec: ConcourseWorkerRecordV1, state: BoardState, alive: boolean): string | undefined {
  if (rec.crash !== undefined && state === 'needs-you') return rec.crash.reason
  if (state === 'needs-you' && !alive && rec.pid !== undefined) return 'its process is gone'
  if (state === 'needs-you' && askingSessions.has(rec.sessionId)) return 'a permission ask is waiting for you'
  if (state === 'paused' && rec.pausedBy !== undefined) return `paused by ${rec.pausedBy}`
  return undefined
}

export function observeSessionStates(workers: Record<string, ConcourseWorkerRecordV1>): void {
  for (const rec of Object.values(workers)) {
    if (!rec.sessionId) continue
    const alive = rec.pid !== undefined && isProcessAlive(rec.pid)
    const state = concourseRecordState(rec, { needsYou: rec.crash !== undefined || askingSessions.has(rec.sessionId), alive })
    const previous = lastStates.get(rec.sessionId)
    if (previous === state) continue
    lastStates.set(rec.sessionId, state)
    if (previous === undefined) continue
    const hookState = hookStateOf(state)
    const from = boardStateOf(previous)
    if (hookState === undefined || from === undefined) continue
    const detail = detailOf(rec, state, alive)
    void fireHooks(
      'session.state',
      {
        state: hookState,
        from,
        ...(detail !== undefined ? { detail } : {}),
        ...(rec.title !== undefined ? { title: rec.title } : {}),
        workspace: rec.workspaceId,
        model: rec.modelKey,
      },
      { scope: { sessionId: rec.sessionId, cwd: rec.workspaceId } },
    ).catch(error => logForDebugging(`session.state hooks failed for ${rec.sessionId}: ${error instanceof Error ? error.message : String(error)}`, { level: 'error' }))
  }
}

export function noteSessionAsking(sessionId: string, asking: boolean, workers: Record<string, ConcourseWorkerRecordV1>): void {
  if (asking) askingSessions.add(sessionId)
  else askingSessions.delete(sessionId)
  observeSessionStates(workers)
}

export function forgetSessionStates(): void {
  lastStates.clear()
  askingSessions.clear()
}
