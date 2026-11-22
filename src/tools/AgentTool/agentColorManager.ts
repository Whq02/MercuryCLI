import type { Theme } from '../../utils/theme.js'
import { notBuilt, unbuilt } from '../../pi/holes.js'

const UNBRANDED_AGENT_TYPE = 'mercury-crew'

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

export const AGENT_COLOR_TO_THEME_COLOR: Record<AgentColorName, keyof Theme> = unbuilt('src/tools/AgentTool/agentColorManager.ts:19')

const agentColorRegistry = new Map<string, AgentColorName>()

function isPaletteColor(value: unknown): value is AgentColorName {
  return (
    typeof value === 'string' &&
    (AGENT_COLORS as readonly string[]).includes(value)
  )
}

export function getAgentColor(agentType: string): keyof Theme | undefined {
  return notBuilt('src/tools/AgentTool/agentColorManager.ts:39')
}

export function setAgentColor(
  agentType: string,
  color: AgentColorName | string | undefined,
): void {
  return notBuilt('src/tools/AgentTool/agentColorManager.ts:46')
}
