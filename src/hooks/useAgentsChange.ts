import { useCallback } from 'react'
import { useTimer } from './effects.js'
import {
  startAgentWatch,
  subscribeAgentsChanged,
} from '../services/agents/watch.js'
import { useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import {
  clearAgentDefinitionsCache,
  computeActiveAgents,
  getAgentDefinitionsWithOverrides,
} from '../tools/AgentTool/loadAgentsDir.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { notBuilt } from '../pi/holes.js'

export async function reloadAgentDefinitionsIntoAppState(
  cwd: string,
  setAppState: (updater: (state: AppState) => AppState) => void,
  opts?: { invalidate?: boolean },
): Promise<void> {
  return notBuilt('src/hooks/useAgentsChange.ts:18')
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
