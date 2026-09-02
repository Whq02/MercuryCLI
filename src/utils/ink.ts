import type { TextProps } from '../ink.js'
import { AGENT_COLOR_TO_THEME_COLOR } from '../tools/AgentTool/agentColorManager.js'

/**
 * Agent colour name → renderer colour property. Absent ⇒ the default
 * subagent theme colour; a known name ⇒ its theme key (follows the active
 * theme); anything else ⇒ the raw terminal colour in the renderer's raw-ANSI
 * form.
 */
export function toInkColor(color: string | undefined): TextProps['color'] {
  if (!color) return 'cyan_FOR_SUBAGENTS_ONLY'
  const themed = (AGENT_COLOR_TO_THEME_COLOR as Record<string, string | undefined>)[color]
  if (themed) return themed as TextProps['color']
  return `ansi:${color}` as TextProps['color']
}
