import type { LocalJSXCommandCall } from '../../types/command.js'
import { openCrewView } from '../../utils/cockpit/crewView.js'
import { parseSpawnSwitchArg } from '../../services/switchboard/spawnSwitches.js'
import { runSpawnSwitchCommand } from './spawnSwitch.js'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const parsed = parseSpawnSwitchArg(args ?? '')
  if (parsed.op === 'on' || parsed.op === 'off' || parsed.op === 'unknown') {
    const receipt = await runSpawnSwitchCommand('subagents', args ?? '')
    onDone(parsed.op === 'unknown' ? receipt : receipt.replace(' — ', '\n'))
    return null
  }
  openCrewView()
  onDone(undefined, { display: 'skip' })
  return null
}
