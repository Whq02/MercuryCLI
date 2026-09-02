
import type { Theme } from '../../utils/theme.js'

const UNBRANDED_AGENT_TYPE = 'general-purpose'

export const AGENT_COLORS = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
] as const

export type AgentColorName = (typeof AGENT_COLORS)[number]

export const AGENT_COLOR_TO_THEME_COLOR: Record<AgentColorName, keyof Theme> = {
  red: 'red_FOR_SUBAGENTS_ONLY',
  blue: 'blue_FOR_SUBAGENTS_ONLY',
  green: 'green_FOR_SUBAGENTS_ONLY',
  yellow: 'yellow_FOR_SUBAGENTS_ONLY',
  purple: 'purple_FOR_SUBAGENTS_ONLY',
  orange: 'orange_FOR_SUBAGENTS_ONLY',
  pink: 'pink_FOR_SUBAGENTS_ONLY',
  cyan: 'cyan_FOR_SUBAGENTS_ONLY',
}

const agentColorRegistry = new Map<string, AgentColorName>()

function isPaletteColor(value: unknown): value is AgentColorName {
  return (
    typeof value === 'string' &&
    (AGENT_COLORS as readonly string[]).includes(value)
  )
}

export function getAgentColor(agentType: string): keyof Theme | undefined {
  if (agentType === UNBRANDED_AGENT_TYPE) return undefined
  const registered = agentColorRegistry.get(agentType)
  if (!isPaletteColor(registered)) return undefined
  return AGENT_COLOR_TO_THEME_COLOR[registered]
}

export function setAgentColor(
  agentType: string,
  color: AgentColorName | string | undefined,
): void {
  if (color === undefined) {
    agentColorRegistry.delete(agentType)
    return
  }
  if (!isPaletteColor(color)) return
  agentColorRegistry.set(agentType, color)
}
