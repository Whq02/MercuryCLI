import type { RunnerPorts } from './runnerPorts.js'
import { setSpawnSwitch, spawnSwitchTransitionLine, SPAWN_SWITCH_LABEL } from '../../services/switchboard/spawnSwitches.js'
import { createRosterTransitionMessage } from '../../utils/messages/systemMessages.js'
import { declareLawfulPrefixChangeForEveryOwner } from '../../services/providers/lawfulPrefixChange.js'

export function landSpawnSwitch(kind: 'subagents', on: boolean, ports: RunnerPorts): void {
  const { messages } = ports
  const landed = setSpawnSwitch(kind, on)
  if (!landed.changed) return
  messages.push(createRosterTransitionMessage(kind, on, spawnSwitchTransitionLine(kind, on)))
  declareLawfulPrefixChangeForEveryOwner(`you turned ${SPAWN_SWITCH_LABEL[kind]} ${on ? 'on' : 'off'}`)
}
