import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../../src/state/AppState.tsx'
import type { SetAppState } from '../../src/Task.ts'
import type { LocalAgentTaskState } from '../../src/tasks/LocalAgentTask/LocalAgentTask.tsx'

const home = mkdtempSync(join(tmpdir(), 'agent-notice-clock-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { completeAgentTask, failAgentTask, killAsyncAgent, enqueueAgentNotification } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { getCommandQueue, resetCommandQueue } = await import('../../src/input-core/command-queue.ts')
let state = getDefaultAppState()
const setState: SetAppState = update => { state = update(state) as AppState }
let failures = 0
const check = (label: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const realNow = Date.now
let now = 1_800_000_000_000
Date.now = () => now
const task = (id: string, registration: AbortController): LocalAgentTaskState => ({ id, agentId: id, type: 'local_agent', description: id, status: 'running', startTime: now - 1000, registration, abortController: registration, isBackgrounded: true, replyTarget: 'parent' }) as LocalAgentTaskState
try {
  for (const status of ['completed', 'failed', 'killed'] as const) {
    resetCommandQueue()
    const controller = new AbortController()
    state.tasks[status] = task(status, controller)
    if (status === 'completed') completeAgentTask({ agentId: status }, setState, controller, { settleFrame: false })
    else if (status === 'failed') failAgentTask(status, 'fixture failure', setState, controller, { settleFrame: false })
    else killAsyncAgent(status, setState, 'stopped', controller)
    const endedAt = state.tasks[status]!.endTime!
    now += 27_000
    enqueueAgentNotification({ taskId: status, description: status, status, setAppState: setState, controller })
    const queued = getCommandQueue()
    check(`${status}: the notice carries completion time, not its later delivery`, queued.length === 1 && queued[0]!.sentAt === new Date(endedAt).toISOString())
    enqueueAgentNotification({ taskId: status, description: status, status, setAppState: setState, controller })
    check(`${status}: the notice still enqueues once`, getCommandQueue().length === 1)
  }
  resetCommandQueue()
  const first = new AbortController()
  state.tasks.resumed = task('resumed', first)
  completeAgentTask({ agentId: 'resumed' }, setState, first, { settleFrame: false })
  const firstEnd = state.tasks.resumed!.endTime!
  now += 27_000
  const second = new AbortController()
  state.tasks.resumed = task('resumed', second)
  enqueueAgentNotification({ taskId: 'resumed', description: 'resumed', status: 'completed', setAppState: setState, controller: first })
  check('a late notice after resume retains the first registration completion', getCommandQueue()[0]?.sentAt === new Date(firstEnd).toISOString())
  check('the earlier notice does not latch its successor', state.tasks.resumed!.status === 'running' && !(state.tasks.resumed as LocalAgentTaskState).notified)
} finally {
  Date.now = realNow
  resetCommandQueue()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures === 0 ? 'PASS' : 'FAIL'} agent notice completion clock`)
process.exit(failures === 0 ? 0 : 1)
