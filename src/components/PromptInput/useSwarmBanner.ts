
import { useContext } from 'react'
import { CockpitActiveContext } from '../../context/cockpitActiveContext.js'
import type { Theme } from '../../utils/theme.js'
import { useAppState, useAppStateStore } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import { getViewedAgent, getViewedCrewmateTask } from '../../state/selectors.js'
import {
  AGENT_COLORS,
  AGENT_COLOR_TO_THEME_COLOR,
  type AgentColorName,
  getAgentColor,
} from '../../tools/AgentTool/agentColorManager.js'

const SUBAGENT_FALLBACK: keyof Theme = 'suggestion'

function themeColorOf(
  name: string | undefined,
  fallback: keyof Theme = SUBAGENT_FALLBACK,
): keyof Theme {
  if (name && (AGENT_COLORS as readonly string[]).includes(name)) {
    return AGENT_COLOR_TO_THEME_COLOR[name as AgentColorName]
  }
  return fallback
}

export function useSwarmBanner(): { text: string; bgColor: keyof Theme } | null {
  const cockpit = useContext(CockpitActiveContext)
  const store = useAppStateStore()
  const crewContext = useAppState((state: AppState) => state.crewContext)
  const standalone = useAppState(
    (state: AppState) => state.standaloneAgentContext,
  )
  const viewingAgentTaskId = useAppState(
    (state: AppState) => state.viewingAgentTaskId,
  )
  void viewingAgentTaskId

  const state = store.getState()

  if (
    crewContext &&
    crewContext.crewName &&
    Object.keys(crewContext.crewmates).length > 0
  ) {
    const viewedCrewmate = getViewedCrewmateTask(state)
    const viewedColor = themeColorOf(
      (viewedCrewmate as { identity?: { color?: string } } | undefined)
        ?.identity?.color,
    )
    if (viewedCrewmate) {
      const name =
        (viewedCrewmate as { identity?: { agentName?: string } }).identity
          ?.agentName ?? ''
      if (name !== '') return { text: name, bgColor: viewedColor }
    }
  }

  const viewedAgent = getViewedAgent(state)
  if (viewedAgent) {
    const name = (viewedAgent as { name?: string }).name
    const agentType = (viewedAgent as { agentType?: string }).agentType
    if (name) {
      return {
        text: `@${name}`,
        bgColor:
          (agentType ? getAgentColor(agentType) : undefined) ??
          SUBAGENT_FALLBACK,
      }
    }
  }

  if (standalone) {
    if (cockpit) return null
    return {
      text: standalone.name ?? '',
      bgColor: themeColorOf(standalone.color),
    }
  }

  const definition = (state as { mainThreadAgentDefinition?: unknown }).mainThreadAgentDefinition as
    | { name?: string; color?: string }
    | undefined
  if (definition?.name) {
    return {
      text: definition.name,
      bgColor: themeColorOf(definition.color, 'promptBorder' as keyof Theme),
    }
  }

  return null
}
