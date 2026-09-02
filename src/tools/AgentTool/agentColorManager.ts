// Agent-type → colour assignment and lookup.
//
// A fixed palette of eight colour names — contract data, because agent
// frontmatter carries them — each mapping to a theme key reserved for
// subagent use. The registry is a process-wide module-level map shared by
// every consumer of this module (load-time registrations are visible to
// renderers because they all read through getAgentColor).

import type { Theme } from '../../utils/theme.js'

/** The default agent type is deliberately unbranded. */
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

/** Palette name → subagent-reserved theme key. */
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

/** The process-wide registry: agent type → registered palette colour. */
const agentColorRegistry = new Map<string, AgentColorName>()

function isPaletteColor(value: unknown): value is AgentColorName {
  return (
    typeof value === 'string' &&
    (AGENT_COLORS as readonly string[]).includes(value)
  )
}

/**
 * The theme key for an agent type's registered colour.
 * Undefined for the default type (unbranded), when nothing is registered,
 * and when the registered value is not in the palette.
 */
export function getAgentColor(agentType: string): keyof Theme | undefined {
  if (agentType === UNBRANDED_AGENT_TYPE) return undefined
  const registered = agentColorRegistry.get(agentType)
  if (!isPaletteColor(registered)) return undefined
  return AGENT_COLOR_TO_THEME_COLOR[registered]
}

/**
 * Register (palette colour), remove (undefined), or ignore (anything else)
 * an agent type's colour.
 */
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
