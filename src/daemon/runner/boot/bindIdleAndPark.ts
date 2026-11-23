import { getRunningTasks } from '../../../engine/task-framework/taskRegistry.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { createIdleTimeoutManager } from '../idleTimeout.js'
import { RunnerQuiescence } from '../../runner-link/runnerQuiescence.js'
import { runnerParkRefusal } from '../parkRefusal.js'
import { flushSessionStorage } from '../../../sessions/transcripts/writer.js'
import { subscribeToCommandQueue, getCommandQueue } from '../messageQueueManager.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

function run(ports: RunnerPorts): BootMade<'stopShellsForClose' | 'settleIdle' | 'idleTimeout' | 'quiescence'> {
  const { getAppState, isLocalShellTask, killTask, live, setAppState } = ports
  const stopShellsForClose = async (): Promise<void> => {
    const shells = getRunningTasks(getAppState()).filter(task => isLocalShellTask(task))
    if (shells.length === 0) return
    logForDebugging(`[session-runner] the input closed with ${shells.length} shell task(s) running: every watch and background shell ends with its seat`)
    await Promise.all(shells.map(task => killTask(task.id, setAppState).catch(passedOverAs(undefined))))
  }

  const settleIdle = async (): Promise<'reenter' | 'close' | 'stay'> => {
    if (live.inputClosed) {
      await stopShellsForClose()
      return 'close'
    }
    return 'stay'
  }

  const idleTimeout = createIdleTimeoutManager(() => !ports.driver.isRunning())

  const quiescence = new RunnerQuiescence({
    refusal: () => runnerParkRefusal(ports),
    flush: () => flushSessionStorage(),
  })
  subscribeToCommandQueue(() => {
    if (getCommandQueue().length > 0) quiescence.invalidate()
  })
  return { stopShellsForClose, settleIdle, idleTimeout, quiescence }
}

export const bindIdleAndPark: BootStep<'stopShellsForClose' | 'settleIdle' | 'idleTimeout' | 'quiescence'> = { name: 'bindIdleAndPark', makes: ['stopShellsForClose', 'settleIdle', 'idleTimeout', 'quiescence'], run }
