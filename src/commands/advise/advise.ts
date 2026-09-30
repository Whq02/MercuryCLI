import {
  ADVISOR_COMMAND,
  ADVISOR_CREWMATE_REFUSAL,
  advisorChatLine,
  advisorSessionSeat,
} from '../../services/advisor/advisorSettings.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import { saveAdvisorSwitch } from '../../utils/sessionStorage.js'

export const ADVISE_USAGE = `usage: ${ADVISOR_COMMAND} on|off — turns the advisor on or off for this chat; ${ADVISOR_COMMAND} alone says the state`

export function parseAdviseArg(rawArg: string): 'on' | 'off' | 'show' | 'unknown' {
  const arg = rawArg.trim().toLowerCase()
  if (arg === '') return 'show'
  if (arg === 'on' || arg === 'off') return arg
  return 'unknown'
}

export function runAdviseCommand(rawArg: string): string {
  const op = parseAdviseArg(rawArg)
  if (op === 'unknown') return ADVISE_USAGE
  if (advisorSessionSeat() !== 'main') return ADVISOR_CREWMATE_REFUSAL
  if (op !== 'show') saveAdvisorSwitch(op === 'on')
  return advisorChatLine()
}

export const call = async (rawArg: string, _context: LocalJSXCommandContext): Promise<LocalCommandResult> => {
  return { type: 'text', value: runAdviseCommand(rawArg) }
}
