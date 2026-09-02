// ============================================================================
//  engageScribeTeam — give the foreground Scribe a team identity so it can reach
//  the daemon-spawned Implementer over the bus, WITHOUT lighting up swarm UI.
//
//  The fg Scribe becomes the team-LEAD of team 'scribe' via AppState.teamContext
//  with an EMPTY teammates map. That is load-bearing on three counts (all
//  verified against source):
//    1. isTeamLead(teamContext) → true (no dynamicTeamContext agentId), so
//       getAgentNameToPoll() falls back to 'team-lead' → the fg polls
//       teams/scribe/inboxes/team-lead.json for the Implementer's replies.
//    2. scribeSenderName() = getAgentName() ?? TEAM_LEAD_NAME = TEAM_LEAD_NAME
//       → resolveDirectActor isLead=true → canDirect ALLOWS the dispatch (no team
//       file or leadAgentId-member juggling needed).
//    3. getTeamName(teamContext) = 'scribe' → dispatches target
//       teams/scribe/inboxes/implementer.json, exactly where the daemon child
//       (spawned --team-name scribe --agent-name implementer) polls.
//  EMPTY teammates ⇒ NO swarm chrome: useSwarmBanner needs teammates.length>0,
//  the teams footer + TaskListV2 count non-'team-lead' members — all no-ops on {}.
//
//  OPT-IN (scribeBusLiveEnabled, default OFF): the live cross-process round-trip
//  is verified only in a creds-available session, so a normal scribe session
//  stays in the verified-honest state until the operator flips MERCURY_SCRIBE_BUS_LIVE=1.
// ============================================================================
import { getTeamFilePath } from '../swarm/teamHelpers.js'
import { getLeadTeamFallback, setLeadTeamFallback } from '../teammate.js'
import { scribeBusLiveEnabled } from './scribeGates.js'
import { armImplementerTelemetryPoll } from './implementerTelemetry.js'

export const SCRIBE_TEAM = 'scribe' as const
export const SCRIBE_LEAD_AGENT_ID = 'scribe@scribe' as const

/** Structural view of the store (src/state/store.ts Store<T>) — testable. */
export type ScribeTeamStore = {
  getState: () => { teamContext?: unknown }
  // A concrete `(prev: AppState) => AppState` updater only unifies with this
  // structural view when the param/return is exactly AppState or `any`
  // (function-param contravariance) — mirror of ScribeSessionStore. `any` keeps
  // the view decoupled from AppState while letting the real AppStateStore satisfy
  // it (the Record→Record form did not, so engageScribeTeam(store) rejected it).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState: (updater: (prev: any) => any) => void
}

// Prior teamContext stashed at engage (module-scoped: the fg is one process and
// the launch mount-effect path can't reach a component ref). null ⇔ not engaged.
// leadFallback rides along: the lead-aware resolver registration (teammate.ts)
// is set/restored in lockstep with the store context.
let priorTeamContext: { value: unknown; leadFallback: string | null } | null = null

/** Test-only: clear the module stash so independent scenarios don't bleed. */
export function __resetScribeTeamStash(): void {
  priorTeamContext = null
}

/**
 * The scribe-lead team context. EMPTY teammates is deliberate (no swarm UI); the
 * Implementer is daemon-bridged, NOT a tracked tmux teammate, so it never goes in
 * this map (that would require fabricating tmux pane fields).
 */
export function buildScribeTeamContext(): Record<string, unknown> {
  return {
    teamName: SCRIBE_TEAM,
    teamFilePath: getTeamFilePath(SCRIBE_TEAM),
    leadAgentId: SCRIBE_LEAD_AGENT_ID,
    isLeader: true,
    selfAgentId: SCRIBE_LEAD_AGENT_ID,
    selfAgentName: 'team-lead',
    teammates: {},
  }
}

/** Make the fg Scribe the lead of team 'scribe'. Idempotent; no-op when the live
 *  bus is OFF. Stashes the prior teamContext for restore. */
export function engageScribeTeam(store: ScribeTeamStore): void {
  if (!scribeBusLiveEnabled()) return
  // Arm the Implementer-telemetry poll on the INTERACTIVE engage path too. The headless
  // QueryEngine path armed it, but the interactive REPL Scribe (the operator's PRIMARY
  // entry) never did — so getImplementerTelemetry() stayed EMPTY all session and the
  // awareness reminder always read "no confirmed-live Implementer / cannot take execution
  // on" even with a live daemon (the #43-R2b telemetry whose own comment is "so the Scribe
  // is not blind"). The poll is idempotent (_armed) + Scribe-MODE self-gating
  // (isScribeModeOn — set by this carousel engage, which never sets the MERCURY_SCRIBE role
  // env) + unref'd, and this fn already early-returns when the bus is OFF (the same gate the
  // telemetry consumer uses) — so this arms exactly when its output is read, never else.
  armImplementerTelemetryPoll()
  if (priorTeamContext !== null) return // already engaged this session
  const st = store.getState()
  priorTeamContext = { value: st.teamContext, leadFallback: getLeadTeamFallback() }
  store.setState(prev => ({ ...prev, teamContext: buildScribeTeamContext() }))
  // Lead-aware tool identity (the round-trip fix, both router
  // types): module-level resolvers (the coordination MCP verbs, TeamBrief's
  // fallback) can't see the store context above — register the team so the
  // Scribe lead's briefs and coordination verbs resolve 'scribe' instead of
  // answering the not-in-a-team empty shape.
  setLeadTeamFallback(SCRIBE_TEAM)
}

/** Restore the pre-engage teamContext. No-op when OFF or never engaged. */
export function disengageScribeTeam(store: ScribeTeamStore): void {
  if (!scribeBusLiveEnabled()) return
  if (priorTeamContext === null) return
  const prior = priorTeamContext.value
  setLeadTeamFallback(priorTeamContext.leadFallback)
  priorTeamContext = null
  store.setState(prev => ({ ...prev, teamContext: prior }))
}

/** Is the fg Scribe currently holding the scribe-team identity? */
export function isScribeTeamEngaged(): boolean {
  return priorTeamContext !== null
}
