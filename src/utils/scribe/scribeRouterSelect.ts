import {
  setScribeMode,
  isScribeModeOn,
  SCRIBE_ROUTER_OPTION_VALUE,
  SCRIBE_ROUTER_WORKFLOWS_OPTION_VALUE,
} from '../scribeMode.js'
import { engageScribeHooks, disengageScribeHooks } from '../hooks/scribeImplementerHooks.js'
import {
  engageScribeSession,
  disengageScribeSession,
  type ScribeSessionStore,
} from './engageScribeSession.js'
import { engageScribeTeam, disengageScribeTeam } from './engageScribeTeam.js'
import type { ScribeTeamStore } from './engageScribeTeam.js'
import { ensureScribeDaemon } from './ensureScribeDaemon.js'
import { clearDaemonHaltStanddown } from '../daemonStanddown.js'
import { setImplementerWorkflowsPosture } from './workflowsPosture.js'
import { setScribeContext1mPref } from './scribeModelPin.js'
import { getSessionId, getProjectRoot } from '../../bootstrap/state.js'
import instances from '../../ink/instances.js'
import { deleteFlagEnv } from '../../substrate/flagRegistry.js'
import type { SetAppState } from '../messageQueueManager.js'

export type ScribeRouterOutcome =
  | 'engaged'
  | 'workflows-engaged'
  | 'workflows-pending-restart'
  | 'disengaged'
  | 'not-router'

export type ScribeRouterDeps = {
  setAppState: SetAppState
  store: ScribeSessionStore & ScribeTeamStore
}

export function classifyScribeRouterModel(
  model: string | null,
): 'router' | 'router-1m' | 'workflows' | 'model' {
  if (model === SCRIBE_ROUTER_WORKFLOWS_OPTION_VALUE) return 'workflows'
  if (model === SCRIBE_ROUTER_OPTION_VALUE) return 'router'
  if (model === `${SCRIBE_ROUTER_OPTION_VALUE}[1m]`) return 'router-1m'
  return 'model'
}

export function handleScribeRouterSelect(
  model: string | null,
  deps: ScribeRouterDeps,
): ScribeRouterOutcome {
  
  const kind = classifyScribeRouterModel(model)

  const engageRouterSession = (context1m: boolean | null): void => {
    if (context1m !== null) setScribeContext1mPref(context1m)
    clearDaemonHaltStanddown()
    setScribeMode(true)
    engageScribeHooks(deps.setAppState, getSessionId())
    engageScribeSession(deps.store)
    engageScribeTeam(deps.store)
    ensureScribeDaemon(getProjectRoot())
    instances.get(process.stdout)?.reassertTerminalModes()
  }

  if (kind === 'workflows') {
    setImplementerWorkflowsPosture(true)
    if (!isScribeModeOn()) {
      engageRouterSession(null)
      return 'workflows-engaged'
    }
    return 'workflows-pending-restart'
  }

  if (kind === 'router' || kind === 'router-1m') {
    if (!isScribeModeOn()) {
      engageRouterSession(kind === 'router-1m')
    }
    return 'engaged'
  }

  if (isScribeModeOn()) {
    setScribeMode(false)
    setImplementerWorkflowsPosture(false)
    disengageScribeHooks(deps.setAppState, getSessionId())
    disengageScribeSession(deps.store)
    disengageScribeTeam(deps.store)
    deleteFlagEnv('MERCURY_SCRIBE')
    setScribeContext1mPref(undefined)
    return 'disengaged'
  }

  return 'not-router'
}
