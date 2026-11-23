import { useCallback } from 'react'
import { useTimer } from '../effects/effects.js'
import {
  startAgentWatch,
  subscribeAgentsChanged,
} from '../../crew/agents/watch.js'
import { useSetAppState } from '../app-state/AppState.js'
import type { AppState } from '../app-state/AppStateStore.js'
import {
  clearAgentDefinitionsCache,
  computeActiveAgents,
  getAgentDefinitionsWithOverrides,
} from '../../tools/crewmate/loadAgentsDir.js'
import { toError } from '../../platform/errors/errors.js'
import { logError } from '../../platform/logs/errorLog.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export async function reloadAgentDefinitionsIntoAppState(
  cwd: string,
  setAppState: (updater: (state: AppState) => AppState) => void,
  opts?: { invalidate?: boolean },
): Promise<void> {
  if (opts?.invalidate) clearAgentDefinitionsCache()
  const fresh = await getAgentDefinitionsWithOverrides(cwd)
  setAppState(state => {
    const flagAgents = state.agentDefinitions.allAgents.filter(
      a => a.source === 'flagSettings',
    )
    const allAgents = [...fresh.allAgents, ...flagAgents]
    return {
      ...state,
      agentDefinitions: {
        ...state.agentDefinitions,
        ...fresh,
        allAgents,
        activeAgents: computeActiveAgents(allAgents),
      },
    }
  })
}


export function useAgentsChange(cwd: string | undefined): void {
  const setAppState = useSetAppState()

  const reload = useCallback(async (): Promise<void> => {
    if (!cwd) return
    try {
      await reloadAgentDefinitionsIntoAppState(cwd, setAppState)
    } catch (error) {
      logError(toError(error))
    }
  }, [cwd, setAppState])

  useTimer(() => {
    if (!cwd) return
    const arm = startTimeout(() => {
      void startAgentWatch(cwd).catch(error => logError(toError(error)))
    }, 1500)
    arm.unref?.()
    const unsubscribe = subscribeAgentsChanged(() => {
      void reload()
    })
    return () => {
      stopTimeout(arm)
      unsubscribe()
    }
  }, [cwd, reload])
}
