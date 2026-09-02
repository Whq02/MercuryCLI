import { isAbsolute } from 'node:path'

import type { AppState } from '../../state/AppState.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import { isAgentSwarmsEnabled } from '../agentSwarmsEnabled.js'
import { logForDebugging } from '../debug.js'
import { addFunctionHook } from '../hooks/sessionHooks.js'
import { applyPermissionUpdate } from '../permissions/PermissionUpdate.js'
import { getAgentId, getAgentName, getTeamName, getTeammateColor } from '../teammate.js'
import { createIdleNotification, getLastPeerDmSummary, writeToMailbox } from '../teammateMailbox.js'
import { TEAM_LEAD_NAME } from './constants.js'
import { readTeamFile, setMemberActive } from './teamHelpers.js'

/**
 * Teammate-side session init: apply the team-wide allow rules and register
 * the idle-notification Stop hook.
 */
/** Session-boot swarm initialisation (Law 9 restore — the old screen's
 *  mount effect owned this; the runner owns it now). Two shapes: a RESUMED
 *  teammate session carries team and agent names on its first transcript
 *  message (the agent id looked up from the stored team file); a FRESH
 *  spawn reads the ambient teammate context — all three names required. */
export function initializeSwarmSession(
  setAppState: (updater: (prevState: AppState) => AppState) => void,
  sessionId: string,
  initialMessages: ReadonlyArray<{ teamName?: string; agentName?: string }> | undefined,
): void {
  if (!isAgentSwarmsEnabled()) return
  const first = initialMessages?.[0]
  if (first?.teamName && first?.agentName) {
    const teamFile = readTeamFile(first.teamName)
    const member = teamFile?.members.find(m => m.name === first.agentName)
    if (!member) {
      logForDebugging(`swarm init: no member "${first.agentName}" in team "${first.teamName}"`)
      return
    }
    initializeTeammateHooks(setAppState, sessionId, {
      teamName: first.teamName,
      agentId: member.agentId,
      agentName: first.agentName,
    })
    return
  }
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName()
  if (teamName && agentId && agentName) {
    initializeTeammateHooks(setAppState, sessionId, { teamName, agentId, agentName })
  }
}

export function initializeTeammateHooks(
  setAppState: (updater: (prevState: AppState) => AppState) => void,
  sessionId: string,
  identity: { teamName: string; agentId: string; agentName: string },
): void {
  const roster = readTeamFile(identity.teamName)
  if (roster === null) {
    logForDebugging(
      `teammate init: no roster for ${identity.teamName} — skipping allow rules and hooks`,
    )
    return
  }

  // Team-wide allowed paths become session-scoped allow rules, one
  // permission update per entry ({ toolName, ruleContent } / allow /
  // session are contract data shared with the permissions slice). The rule
  // content is the path plus `/**`, and an ABSOLUTE path gets one extra
  // leading `/` (the root-anchored form the rule engine expects).
  // Absoluteness is decided with the platform's own predicate, never a
  // leading-slash test — a Windows absolute path read as relative produced
  // a rule that could never match.
  for (const allowedPath of roster.allowedPaths ?? []) {
    const anchored = isAbsolute(allowedPath.path) ? `/${allowedPath.path}` : allowedPath.path
    const update: PermissionUpdate = {
      type: 'addRules',
      rules: [{ toolName: allowedPath.toolName, ruleContent: `${anchored}/**` }],
      behavior: 'allow',
      destination: 'session',
    }
    setAppState(prevState => ({
      ...prevState,
      toolPermissionContext: applyPermissionUpdate(prevState.toolPermissionContext, update),
    }))
  }

  const leadName =
    roster.members.find(member => member.agentId === roster.leadAgentId)?.name ?? TEAM_LEAD_NAME

  if (identity.agentId === roster.leadAgentId) {
    logForDebugging('teammate init: this agent IS the team lead — no Stop hook registered')
    return
  }

  // Stop hooks here are pure observers: the hook always allows the stop to
  // proceed, and the roster idle mark is fire and forget. The mailbox write
  // is AWAITED because the process may be shutting down.
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '',
    async messages => {
      void setMemberActive(identity.teamName, identity.agentName, false)
      const summary = getLastPeerDmSummary(messages)
      const notification = createIdleNotification(identity.agentName, {
        idleReason: 'available',
        ...(summary !== undefined ? { summary } : {}),
      })
      const color = getTeammateColor()
      await writeToMailbox(leadName, {
        from: identity.agentName,
        text: JSON.stringify(notification),
        timestamp: new Date().toISOString(),
        ...(color !== undefined ? { color } : {}),
      })
      return true
    },
    'The teammate idle notification could not be delivered',
    // silent: a pure observer must not inflate the teammate transcript's
    // "Ran N stop-hook hooks" count; delivery failures still surface as
    // hook_error_during_execution attachments.
    { timeout: 10_000, silent: true },
  )
}
