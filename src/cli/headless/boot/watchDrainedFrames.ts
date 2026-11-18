import * as inputDoor from '../inputDoor.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'stopDrainedNotificationFrames'> {
  const stopDrainedNotificationFrames = inputDoor.watchDrainedNotifications(ports)
  return { stopDrainedNotificationFrames }
}

export const watchDrainedFrames: BootStep<'stopDrainedNotificationFrames'> = { name: 'watchDrainedFrames', makes: ['stopDrainedNotificationFrames'], run }
