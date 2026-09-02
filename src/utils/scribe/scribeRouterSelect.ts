// ============================================================================
//  scribeRouterSelect — the SHARED "Scribe — two-stream router" selection logic
//  used by BOTH /model pickers: the inline ModelPicker (chat:modelPicker keybinding,
//  via PromptInput.handleModelSelect) AND the /model command's MercuryModelPicker
//  (mercuryModel.tsx). Centralized so the two pickers can never drift — the bug that
//  shipped was mercuryModel writing the raw sentinel as the model instead of engaging.
//
//  Returns the OUTCOME; the caller acts on it:
//    'engaged' / 'workflows-engaged'  → do NOT write a model (return early)
//    'workflows-pending-restart'      → posture armed but the two-stream is already
//                                       up WITHOUT it — do NOT write a model; the
//                                       caller says so honestly (applies next engage)
//    'disengaged'                     → fall through and APPLY the chosen real model
//    'not-router'                     → a normal model select, proceed as usual
// ============================================================================
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

/**
 * Pure-ish classifier: is this selected model value a Scribe-router sentinel (or its
 * [1m] variant), the gated workflows sibling, or a normal model? No side effects.
 */
export function classifyScribeRouterModel(
  model: string | null,
): 'router' | 'router-1m' | 'workflows' | 'model' {
  if (model === SCRIBE_ROUTER_WORKFLOWS_OPTION_VALUE) return 'workflows'
  if (model === SCRIBE_ROUTER_OPTION_VALUE) return 'router'
  if (model === `${SCRIBE_ROUTER_OPTION_VALUE}[1m]`) return 'router-1m'
  return 'model'
}

/**
 * Apply a /model selection's Scribe-router semantics (shared by both pickers).
 * Engages on the router sentinel (honoring the 1M/200k `c` choice via the scribe
 * context pref), engages the workflow-capable variant on the workflows sibling
 * (router engage + the workflows posture), and disengages when a REAL model is
 * chosen while scribe mode is on. Returns the outcome (see file header).
 */
export function handleScribeRouterSelect(
  model: string | null,
  deps: ScribeRouterDeps,
): ScribeRouterOutcome {
  
  const kind = classifyScribeRouterModel(model)

  // The ONE engage sequence, shared by the router and workflows rows so the two
  // paths can never drift (the same reason this module exists for the two pickers).
  const engageRouterSession = (context1m: boolean | null): void => {
    // The picker's `c` toggle rides on the sentinel: the [1m] variant ⇒ 1M
    // (default), the bare sentinel ⇒ 200k. Set the pref BEFORE engage so the pin
    // resolves to the chosen context width. `null` (the workflows row has no [1m]
    // sibling) leaves the pref untouched ⇒ the pin's default width.
    if (context1m !== null) setScribeContext1mPref(context1m)
    // Engaging Scribe is the operator's explicit word — a /halt stand-down
    // ends here, so the ensure below may spawn again.
    clearDaemonHaltStanddown()
    setScribeMode(true)
    engageScribeHooks(deps.setAppState, getSessionId())
    // COUPLED model+effort pin via the SHARED, idempotent, never-clobber helper.
    engageScribeSession(deps.store)
    engageScribeTeam(deps.store)
    // Auto-start the daemon + Implementer (gated, idempotent, reaped on exit).
    ensureScribeDaemon(getProjectRoot())
    // Terminal-mode belt: both operator
    // breaks began at a router engage — heavy repaint + daemon spawn is the
    // same signal class the sleep-wake / stdin-resume re-asserts cover, so
    // idempotently re-arm mouse tracking + alternate-scroll here too.
    instances.get(process.stdout)?.reassertTerminalModes()
  }

  if (kind === 'workflows') {
    // The workflow-capable variant IS the router engage + the workflows posture.
    // Arm the posture FIRST so ensureScribeDaemon stamps it onto the daemon env
    // (buildScribeDaemonExtraEnv → MERCURY_DAEMON_SCRIBE_WORKFLOWS → the
    // Implementer child spec's MERCURY_IMPLEMENTER_WORKFLOWS).
    setImplementerWorkflowsPosture(true)
    if (!isScribeModeOn()) {
      engageRouterSession(null)
      return 'workflows-engaged'
    }
    // Already engaged: the daemon + Implementer are up WITHOUT the posture, and
    // ensureScribeDaemon idempotently no-ops on a live daemon. Honest outcome —
    // the caller says the posture applies on the next engage; silently claiming
    // "workflows armed" here would be a live-surface lie.
    return 'workflows-pending-restart'
  }

  if (kind === 'router' || kind === 'router-1m') {
    // Re-selecting while already engaged is an idempotent no-op (the engage
    // helpers guard via decideScribeSessionModel / the module stash).
    if (!isScribeModeOn()) {
      engageRouterSession(kind === 'router-1m')
    }
    return 'engaged'
  }

  // A real model chosen while in scribe mode is the EXIT — disengage, then the
  // caller applies the chosen model (it wins over the restored pin).
  if (isScribeModeOn()) {
    setScribeMode(false)
    // The workflows posture clears with the exit — the two-stream is ending;
    // the chosen real model is a plain foreground session again (#28). A
    // fresh engage re-arms it only via the workflows row.
    setImplementerWorkflowsPosture(false)
    disengageScribeHooks(deps.setAppState, getSessionId())
    disengageScribeSession(deps.store)
    disengageScribeTeam(deps.store)
    // Env-launched sessions (MERCURY_SCRIBE=1): the exit ends the ROLE too.
    // Leaving the role env set made a later role engage refuse FOREVER after
    // a scribe exit ("this session already runs another role:
    // MERCURY_SCRIBE") — a dead end, since the scribe surface it named was
    // already torn down; it also let stray isScribeRole() consumers read a
    // role that had ended.
    deleteFlagEnv('MERCURY_SCRIBE')
    // Clear the 1M-context pref AFTER disengage so the restore-match (modelIsScribePin)
    // saw the resolved pinned variant; the next engage starts fresh.
    setScribeContext1mPref(undefined)
    return 'disengaged'
  }

  return 'not-router'
}
