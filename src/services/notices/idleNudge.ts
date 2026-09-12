import { flagEnv } from '../../substrate/flagRegistry.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { agentWaitElapsed } from '../../tasks/LocalAgentTask/agentWait.js'
import type { TaskState } from '../../tasks/types.js'
import { taskOwnerGone } from '../../utils/task/framework.js'
import {
  MAIN_THREAD_AGENT,
  markNudged,
  openNotices,
  retireNotice,
  subscribeNoticeLedger,
  type NoticeRecord,
} from './unreadLedger.js'


export const NOTICE_DEADLINE_DEFAULT_MS = 180_000
export const NOTICE_DEADLINE_FLOOR_MS = 1_000
const SWEEP_FLOOR_MS = 25

export function noticeDeadlineMs(): number {
  const raw = flagEnv('MERCURY_NOTICE_DEADLINE_MS')
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return NOTICE_DEADLINE_DEFAULT_MS
  const parsed = Number(raw.trim())
  return parsed >= NOTICE_DEADLINE_FLOOR_MS ? parsed : NOTICE_DEADLINE_DEFAULT_MS
}

export type NoticeRecipientState = { state: 'idle' } | { state: 'busy' } | { state: 'gone'; why: string }

function endedWords(status: string): string {
  switch (status) {
    case 'completed':
      return 'its run ended'
    case 'failed':
      return 'its run failed'
    case 'killed':
      return 'it was stopped'
    default:
      return `its run ${status}`
  }
}

export function noticeRecipientTask(tasks: Record<string, TaskState> | undefined, agentId: string): TaskState | undefined {
  const own = tasks?.[agentId]
  if (own !== undefined) return own
  let first: TaskState | undefined
  for (const task of Object.values(tasks ?? {})) {
    if (!isInProcessTeammateTask(task) || task.identity.agentId !== agentId) continue
    if (task.status === 'running') return task
    first ??= task
  }
  return first
}

export function agentRecipientState(tasks: Record<string, TaskState> | undefined, agentId: string): NoticeRecipientState {
  const task = noticeRecipientTask(tasks, agentId)
  if (task === undefined) return { state: 'gone', why: 'no agent by that id in this session' }
  if (isInProcessTeammateTask(task)) {
    if (task.status !== 'running') return { state: 'gone', why: endedWords(task.status) }
    return task.isIdle ? { state: 'idle' } : { state: 'busy' }
  }
  if (task.status === 'running') {
    const gone = taskOwnerGone(task)
    return gone === null ? { state: 'busy' } : { state: 'gone', why: gone }
  }
  if (task.status === 'pending') return { state: 'busy' }
  if ((task as { paused?: unknown }).paused !== undefined) return { state: 'busy' }
  return { state: 'gone', why: endedWords(task.status) }
}

export interface IdleNudgePorts {
  recipient(agentId: string): NoticeRecipientState
  wake(agentId: string, notices: readonly NoticeRecord[]): boolean
  discard?(notices: readonly NoticeRecord[]): void
  now?(): number
  deadlineMs?(): number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

export interface NudgeSweepReceipt {
  nudged: NoticeRecord[]
  retired: NoticeRecord[]
  waiting: number
  nextInMs: number | null
}

export interface IdleNudge {
  sweep(): NudgeSweepReceipt
  stop(): void
}

export function nudgeWords(notices: readonly NoticeRecord[], waitedMs: number, bodies?: readonly string[]): string {
  const n = notices.length
  const one = n === 1
  const waited = agentWaitElapsed(waitedMs)
  const road = bodies !== undefined
    ? `${one ? 'here it is' : 'here they are'}, oldest first`
    : `${one ? 'it arrives as the turn' : 'they arrive as the turns'} just before this one; read ${one ? 'it' : 'them'} and act on anything still open`
  const lines = [`${n} notice${one ? '' : 's'} waited unread for ${waited} while you were idle — ${road}:`]
  for (const notice of notices) lines.push(`- ${notice.words}`)
  if (bodies !== undefined) {
    for (const body of bodies) {
      lines.push('')
      lines.push(body)
    }
  }
  return `<system-reminder>\n${lines.join('\n')}\n</system-reminder>`
}

export function startIdleNudge(ports: IdleNudgePorts): IdleNudge {
  const now = (): number => ports.now?.() ?? Date.now()
  const deadline = (): number => ports.deadlineMs?.() ?? noticeDeadlineMs()
  const setTimer = ports.setTimer ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  })
  const clearTimer = ports.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let timer: unknown = null
  let stopped = false

  const disarm = (): void => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  const nextInMs = (): number | null => {
    const at = now()
    const limit = deadline()
    let soonest: number | null = null
    for (const notice of openNotices()) {
      if (notice.nudgedAtMs !== undefined) continue
      const remaining = notice.deliveredAtMs + limit - at
      const wait = remaining > 0 ? remaining : limit
      if (soonest === null || wait < soonest) soonest = wait
    }
    return soonest === null ? null : Math.max(SWEEP_FLOOR_MS, soonest)
  }

  const arm = (): void => {
    disarm()
    if (stopped) return
    const wait = nextInMs()
    if (wait === null) return
    timer = setTimer(() => {
      timer = null
      sweep()
    }, wait)
  }

  const sweep = (): NudgeSweepReceipt => {
    const at = now()
    const limit = deadline()
    const due = new Map<string, NoticeRecord[]>()
    for (const notice of openNotices()) {
      if (notice.nudgedAtMs !== undefined || at - notice.deliveredAtMs < limit) continue
      const group = due.get(notice.agentId)
      if (group === undefined) due.set(notice.agentId, [notice])
      else group.push(notice)
    }
    const receipt: NudgeSweepReceipt = { nudged: [], retired: [], waiting: 0, nextInMs: null }
    for (const [agentId, notices] of due) {
      const recipient = ports.recipient(agentId)
      if (recipient.state === 'gone') {
        for (const notice of notices) {
          if (retireNotice(notice.id, `the agent is gone — ${recipient.why}`)) receipt.retired.push(notice)
        }
        try {
          ports.discard?.(notices)
        } catch {
        }
        continue
      }
      if (recipient.state === 'busy') {
        receipt.waiting += notices.length
        continue
      }
      let delivered = false
      try {
        delivered = ports.wake(agentId, notices)
      } catch {
        delivered = false
      }
      if (delivered) {
        markNudged(notices.map(n => n.id))
        receipt.nudged.push(...notices)
      }
    }
    arm()
    receipt.nextInMs = timer === null ? null : nextInMs()
    return receipt
  }

  const unsubscribe = subscribeNoticeLedger(() => arm())
  arm()
  return {
    sweep,
    stop: () => {
      stopped = true
      disarm()
      unsubscribe()
    },
  }
}

export { MAIN_THREAD_AGENT }
