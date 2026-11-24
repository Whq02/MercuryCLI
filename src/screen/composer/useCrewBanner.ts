
import { useContext } from 'react'
import { CockpitActiveContext } from '../cockpit/cockpitActiveContext.js'
import type { Theme } from '../theme/theme.js'
import { useAppState, useAppStateStore } from '../app-state/AppState.js'
import type { AppState } from '../app-state/AppStateStore.js'
import { getViewedCrewmate } from '../app-state/selectors.js'
import {
  AGENT_COLORS,
  AGENT_COLOR_TO_THEME_COLOR,
  getAgentColor,
} from '../../tools/crewmate/crewmateColors.js'
import { isOneOf } from '../../platform/primitives/isOneOf.js'

const CREWMATE_FALLBACK: keyof Theme = 'suggestion'

function themeColorOf(
  name: string | undefined,
  fallback: keyof Theme = CREWMATE_FALLBACK,
): keyof Theme {
  if (name && isOneOf(AGENT_COLORS, name)) {
    return AGENT_COLOR_TO_THEME_COLOR[name]
  }
  return fallback
}

export function useCrewBanner(): { text: string; bgColor: keyof Theme } | null {
  const cockpit = useContext(CockpitActiveContext)
  const store = useAppStateStore()
  const standalone = useAppState(
    (state: AppState) => state.standaloneAgentContext,
  )
  const viewingAgentTaskId = useAppState(
    (state: AppState) => state.viewingAgentTaskId,
  )
  void viewingAgentTaskId

  const state = store.getState()

  const viewedAgent = getViewedCrewmate(state)
  if (viewedAgent) {
    const name = (viewedAgent as { name?: string }).name
    const agentType = (viewedAgent as { agentType?: string }).agentType
    if (name) {
      return {
        text: `@${name}`,
        bgColor:
          (agentType ? getAgentColor(agentType) : undefined) ??
          CREWMATE_FALLBACK,
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
