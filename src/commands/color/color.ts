import type { UUID } from 'node:crypto'
import { getSessionId } from '../../bootstrap/state.js'
import { AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { saveAgentColor } from '../../utils/sessionStorage.js'
import { getTranscriptPath } from '../../utils/sessionStorage/paths.js'
import { isSwarmWorker } from '../../utils/swarm/permissionSync.js'

/**
 * Persisted reset sentinel (contract data): the literal string `default` is
 * stored, never an empty string — truthiness guards in the session store
 * would drop an empty value, and the reset would not survive a restart.
 */
const RESET_SENTINEL = 'default'

/** Argument spellings that mean "back to the default" (contract data). */
const RESET_ALIASES = new Set(['default', 'reset', 'none', 'gray', 'grey'])

function availableColorList(): string {
  return `${AGENT_COLORS.join(', ')}, ${RESET_SENTINEL}`
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const done = (message: string): null => {
    onDone(message, { display: 'system' })
    return null
  }

  if (isSwarmWorker()) {
    return done('Teammate colours are assigned by the team leader — /color is unavailable in a teammate session.')
  }

  const raw = args.trim()
  if (!raw) {
    return done(`Pick a session colour: ${availableColorList()}.`)
  }

  const token = raw.toLowerCase().trim()

  if (RESET_ALIASES.has(token)) {
    await saveAgentColor(getSessionId() as UUID, RESET_SENTINEL, getTranscriptPath())
    context.setAppState(prev => ({
      ...prev,
      standaloneAgentContext: {
        name: prev.standaloneAgentContext?.name ?? '',
        color: undefined,
      },
    }))
    return done('Session colour reset to the default.')
  }

  if (!(AGENT_COLORS as readonly string[]).includes(token)) {
    return done(`"${raw}" is not a colour I know. Pick one of: ${availableColorList()}.`)
  }

  const color = token as AgentColorName
  await saveAgentColor(getSessionId() as UUID, color, getTranscriptPath())
  context.setAppState(prev => ({
    ...prev,
    standaloneAgentContext: {
      name: prev.standaloneAgentContext?.name ?? '',
      color,
    },
  }))
  return done(`Session colour set to ${color}.`)
}
