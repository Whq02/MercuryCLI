import type { RunnerPorts } from './runnerPorts.js'
import { setSpawnSwitch, spawnSwitchTransitionLine, SPAWN_SWITCH_LABEL } from '../switchboard/spawnSwitches.js'
import { createRosterTransitionMessage } from '../../engine/message-shapes/systemMessages.js'
import { declareLawfulPrefixChangeForEveryOwner } from '../../models/roads/lawfulPrefixChange.js'

export function landSpawnSwitch(kind: 'subagents', on: boolean, ports: RunnerPorts): void {
  const { messages } = ports
  const landed = setSpawnSwitch(kind, on)
  if (!landed.changed) return
  messages.push(createRosterTransitionMessage(kind, on, spawnSwitchTransitionLine(kind, on)))
  declareLawfulPrefixChangeForEveryOwner(`you turned ${SPAWN_SWITCH_LABEL[kind]} ${on ? 'on' : 'off'}`)
}
