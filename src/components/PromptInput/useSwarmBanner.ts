// The destination banner: resolves in rung order to a label plus a
// theme colour key, or nothing. The viewed-agent id is subscribed
// EXPLICITLY — the projection is fetched imperatively from the store and
// would otherwise not re-render on entering or leaving a view. The
// multiplexer probe is tri-state: while unresolved, the leader rung falls
// through.

import { useEffect, useState } from 'react'
import type { Theme } from '../../utils/theme.js'
import { useAppState, useAppStateStore } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import { getViewedAgent, getViewedTeammateTask } from '../../state/selectors.js'
import {
  AGENT_COLORS,
  AGENT_COLOR_TO_THEME_COLOR,
  type AgentColorName,
  getAgentColor,
} from '../../tools/AgentTool/agentColorManager.js'
import {
  TEAMMATE_COLOR_ENV_VAR,
  getSwarmSocketName,
} from '../../utils/swarm/constants.js'
import { isInsideTmux } from '../../utils/swarm/backends/detection.js'
import { getTeammateModeFromSnapshot } from '../../utils/swarm/backends/teammateModeSnapshot.js'

const SUBAGENT_FALLBACK: keyof Theme = 'suggestion'

/** Validate a colour name against the known agent-colour list; fall back to
 *  the subagent colour (or a caller-supplied fallback). */
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
  const store = useAppStateStore()
  const teamContext = useAppState((state: AppState) => state.teamContext)
  const standalone = useAppState(
    (state: AppState) => state.standaloneAgentContext,
  )
  // Explicit subscription: entering/leaving a view must re-render.
  const viewingAgentTaskId = useAppState(
    (state: AppState) => state.viewingAgentTaskId,
  )
  void viewingAgentTaskId

  // Tri-state multiplexer probe.
  const [insideTmux, setInsideTmux] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    void isInsideTmux()
      .then(value => {
        if (!cancelled) setInsideTmux(value)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const state = store.getState()
  const envColor = process.env[TEAMMATE_COLOR_ENV_VAR]

  // 1 · a teammate PROCESS (not in-process) with both names.
  const teammateMode = getTeammateModeFromSnapshot()
  if (
    teamContext &&
    teamContext.isLeader !== true &&
    teammateMode !== 'in-process' &&
    teamContext.selfAgentName &&
    teamContext.teamName
  ) {
    return {
      text: teamContext.selfAgentName,
      bgColor: themeColorOf(teamContext.selfAgentColor ?? envColor),
    }
  }

  // 2 · a leader with spawned teammates.
  if (
    teamContext &&
    teamContext.teamName &&
    Object.keys(teamContext.teammates).length > 0
  ) {
    const viewedTeammate = getViewedTeammateTask(state)
    const viewedColor = themeColorOf(
      (viewedTeammate as { identity?: { color?: string } } | undefined)
        ?.identity?.color,
    )
    const inProcessOrPanes = teammateMode === 'in-process'
    if (insideTmux === false && !inProcessOrPanes) {
      return {
        text: `attach: tmux -L ${getSwarmSocketName()} attach`,
        bgColor: viewedColor,
      }
    }
    if ((insideTmux === true || inProcessOrPanes) && viewedTeammate) {
      const name =
        (viewedTeammate as { identity?: { agentName?: string } }).identity
          ?.agentName ?? ''
      if (name !== '') return { text: name, bgColor: viewedColor }
    }
    // Probe unresolved, or no teammate viewed: fall through.
  }

  // 3 · viewing a local background agent.
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

  // 4 · a standalone agent with a renamed name and/or custom colour.
  if (standalone) {
    return {
      text: standalone.name ?? '',
      bgColor: themeColorOf(standalone.color),
    }
  }

  // 5 · an --agent CLI selection.
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
