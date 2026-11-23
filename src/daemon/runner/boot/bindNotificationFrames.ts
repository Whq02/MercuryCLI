import * as inputDoor from '../inputDoor.js'
import type { QueuedCommand } from '../../../screen/composer/input-core/textInput.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'emitTaskNotificationFrames' | 'announcedNotifications' | 'emitCommandNotifications' | 'retireQueuedCommands'> {
  const emitTaskNotificationFrames = (payloads: readonly string[]): void => inputDoor.emitTaskNotificationFrames(payloads, ports)

  const announcedNotifications = new WeakSet<QueuedCommand>()
  const emitCommandNotifications = (commands: readonly QueuedCommand[]): void => inputDoor.emitCommandNotifications(commands, ports)

  const retireQueuedCommands = (commands: QueuedCommand[]): void => inputDoor.retireQueuedCommands(commands, ports)
  return { emitTaskNotificationFrames, announcedNotifications, emitCommandNotifications, retireQueuedCommands }
}

export const bindNotificationFrames: BootStep<'emitTaskNotificationFrames' | 'announcedNotifications' | 'emitCommandNotifications' | 'retireQueuedCommands'> = { name: 'bindNotificationFrames', makes: ['emitTaskNotificationFrames', 'announcedNotifications', 'emitCommandNotifications', 'retireQueuedCommands'], run }
