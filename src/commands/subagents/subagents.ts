import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import {
  parseSpawnSwitchArg,
  spawnSwitchLine,
  spawnSwitchToggleReceipt,
  SPAWN_SWITCH_COMMAND,
  type SpawnSwitchKind,
} from '../../services/switchboard/spawnSwitches.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'

/** The one body both spawn-switch commands share: a readout with no
 *  argument, a flip on `on`/`off`, the usage line otherwise. The receipt is
 *  the daemon's own word (applied · queued · noop · refused). */
export async function runSpawnSwitchCommand(kind: SpawnSwitchKind, rawArg: string): Promise<string> {
  const parsed = parseSpawnSwitchArg(rawArg)
  if (parsed.op === 'unknown') {
    return `usage: ${SPAWN_SWITCH_COMMAND[kind]} on|off — flips this session's switch at the next turn boundary; ${SPAWN_SWITCH_COMMAND[kind]} alone reads both switches`
  }
  if (!hasFocusedSession()) {
    return `no chat is open — ${SPAWN_SWITCH_COMMAND[kind]} acts on the focused session; the boot menu's Agents section sets the next session's default`
  }
  const focused = getFocusedSessionConnector()
  if (parsed.op === 'show') {
    const facts = focused.spawnSwitches()
    return `${spawnSwitchLine('subagents', facts.subagents)} · ${spawnSwitchLine('workflows', facts.workflows)} — /subagents on|off and /workflows on|off flip this session at its next turn boundary; the boot menu's Agents section sets the next session's default`
  }
  const on = parsed.op === 'on'
  const receipt = await focused.setSpawnSwitch(kind, on)
  return receipt.detail ?? spawnSwitchToggleReceipt(kind, on, receipt.outcome)
}

export const call = async (rawArg: string, _context: LocalJSXCommandContext): Promise<LocalCommandResult> => {
  return { type: 'text', value: await runSpawnSwitchCommand('subagents', rawArg) }
}
