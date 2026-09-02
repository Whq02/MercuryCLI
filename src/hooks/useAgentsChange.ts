import { useCallback, useEffect } from 'react'
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

/**
 * The ONE AppState refresh for agent definitions: re-read through
 * the loader and swap the state, preserving what only the session knows —
 * `--agents` flag definitions and `allowedAgentTypes`. Every mutation surface
 * (the Studio's save/delete/toggle, the watch reload) funnels here; nobody
 * hand-patches agentDefinitions optimistically anymore.
 */
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

/**
 * live reload: keep AppState.agentDefinitions fresh across on-disk
 * definition changes. The watch owner (services/agents/watch.ts) coalesces
 * fs events and skips self-writes; this hook re-reads through the (now
 * invalidated) loader and swaps AppState.
 *
 * Reload preserves what only the session knows: `--agents` flag definitions
 * (source 'flagSettings' — never file-backed) and `allowedAgentTypes`.
 * In-flight subagents keep the definition OBJECT captured at spawn — a
 * reload replaces the AppState list, never mutates prior objects, so running
 * work stays pinned to its start revision while the NEXT invocation sees the
 * newest committed one.
 */
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

  useEffect(() => {
    if (!cwd) return
    // Arm the watcher OFF the boot window: hot reload is a background
    // affordance, and chokidar's initial root scan must not compete with the
    // first paint (a board's dossier leg measured the cost under the
    // gate's 2-slot PTY load — pool round 1).
    const arm = setTimeout(() => {
      void startAgentWatch(cwd).catch(error => logError(toError(error)))
    }, 1500)
    arm.unref?.()
    const unsubscribe = subscribeAgentsChanged(() => {
      void reload()
    })
    return () => {
      clearTimeout(arm)
      unsubscribe()
    }
  }, [cwd, reload])
}
