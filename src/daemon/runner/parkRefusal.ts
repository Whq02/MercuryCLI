import { capabilityHoldWords, runnerCapabilityHolds } from '../runner-link/runnerCapabilityCensus.js'
import { getCommandQueue } from './messageQueueManager.js'
import { getRunningTasks } from '../../engine/task-framework/taskRegistry.js'
import type { RunnerPorts } from './runnerPorts.js'

export function runnerParkRefusal(ports: RunnerPorts): string | null {
  const { asks, driver, getAppState, isMainThreadCommand } = ports
  if (driver.isRunning()) return 'a turn is running'
  if (getCommandQueue().some(isMainThreadCommand)) return 'a prompt is queued'
  const busy = getRunningTasks(getAppState())
  if (busy.length > 0) return `${busy.length} background task(s) still running`
  return capabilityHoldWords(runnerCapabilityHolds(asks))
}
