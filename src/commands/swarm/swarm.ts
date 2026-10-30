import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import { saveSwarmSwitch } from '../../utils/sessionStorage/logs.js'
import { closeIdleSwarm, swarmMasterEnabled, swarmSessionEnabled, swarmStore } from '../../services/crewBoard/seam.js'

export function runSwarmCommand(raw: string): string {
  const op = raw.trim().toLowerCase()
  if (op !== '' && op !== 'on' && op !== 'off') return 'usage: /swarm on|off — /swarm alone shows the state'
  if (!swarmMasterEnabled()) {
    if (op === 'off') saveSwarmSwitch(false)
    return 'Swarm is off — enable swarm.enabled in your user settings.json (/config → Swarm).'
  }
  if (op !== '') saveSwarmSwitch(op === 'on')
  if (op === 'off') closeIdleSwarm()
  if (!swarmSessionEnabled()) return 'Swarm off for new crewmates — existing board crewmates keep their board; /swarm on enables it.'
  try { swarmStore() } catch (error) {
    saveSwarmSwitch(false)
    return `Swarm could not open: ${error instanceof Error ? error.message : String(error)}`
  }
  return 'Swarm on for new crewmates — board context 6,000 tokens per agent, 40,000 per wave; no extra turns.'
}

export async function call(raw: string, _context: LocalJSXCommandContext): Promise<LocalCommandResult> {
  return { type: 'text', value: runSwarmCommand(raw) }
}
