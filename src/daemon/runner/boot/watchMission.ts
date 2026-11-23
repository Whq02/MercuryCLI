import { missionUpdatedRow, samplesUpdatedRow } from '../../../engine/rows/project.js'
import { onTasksUpdated } from '../../../engine/task-framework/tasks.js'
import { subscribeSampleChanges } from '../../../integrations/samples/store.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { startTimeout } from '../../../platform/async/timers.js'

async function run(ports: RunnerPorts): Promise<BootMade<'missionGuard'>> {
  const { enqueueRow, liveScope } = ports
  const missionGuard = await import('../../../permissions/guards/mission.js')
  {
    let missionTimer: NodeJS.Timeout | null = null
    const missionMoved = (): void => {
      if (missionTimer !== null) return
      missionTimer = startTimeout(() => {
        missionTimer = null
        enqueueRow(missionUpdatedRow(liveScope()))
      }, 50)
      missionTimer.unref?.()
    }
    onTasksUpdated(missionMoved)
    missionGuard.subscribeActiveMission(missionMoved)
  }
  {
    let samplesTimer: NodeJS.Timeout | null = null
    subscribeSampleChanges(() => {
      if (samplesTimer !== null) return
      samplesTimer = startTimeout(() => {
        samplesTimer = null
        enqueueRow(samplesUpdatedRow(liveScope()))
      }, 50)
      samplesTimer.unref?.()
    })
  }
  return { missionGuard }
}

export const watchMission: BootStep<'missionGuard'> = { name: 'watchMission', makes: ['missionGuard'], run }
