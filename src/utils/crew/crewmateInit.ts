import { isAbsolute } from 'node:path'

import type { AppState } from '../../state/AppState.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import { isCrewEnabled } from '../crewEnabled.js'
import { logForDebugging } from '../debug.js'
import { addFunctionHook } from '../hooks/sessionHooks.js'
import { applyPermissionUpdate } from '../permissions/PermissionUpdate.js'
import { getAgentId, getAgentName, getCrewName, getCrewmateColor } from '../crewmate.js'
import { sendLiveMessage } from '../../services/crew/liveComms.js'
import { createIdleNotification, getLastPeerDmSummary } from '../../services/crew/liveMessages.js'
import { CREW_LEAD_NAME } from './constants.js'
import { readCrewFile, setMemberActive } from './crewHelpers.js'

export function initializeCrewSession(
  setAppState: (updater: (prevState: AppState) => AppState) => void,
  sessionId: string,
  initialMessages: ReadonlyArray<{ crewName?: string; agentName?: string }> | undefined,
): void {
  if (!isCrewEnabled()) return
  const first = initialMessages?.[0]
  if (first?.crewName && first?.agentName) {
    const crewFile = readCrewFile(first.crewName)
    const member = crewFile?.members.find(m => m.name === first.agentName)
    if (!member) {
      logForDebugging(`crew init: no member "${first.agentName}" in crew "${first.crewName}"`)
      return
    }
    initializeCrewmateHooks(setAppState, sessionId, {
      crewName: first.crewName,
      agentId: member.agentId,
      agentName: first.agentName,
    })
    return
  }
  const crewName = getCrewName()
  const agentId = getAgentId()
  const agentName = getAgentName()
  if (crewName && agentId && agentName) {
    initializeCrewmateHooks(setAppState, sessionId, { crewName, agentId, agentName })
  }
}

export function initializeCrewmateHooks(
  setAppState: (updater: (prevState: AppState) => AppState) => void,
  sessionId: string,
  identity: { crewName: string; agentId: string; agentName: string },
): void {
  const roster = readCrewFile(identity.crewName)
  if (roster === null) {
    logForDebugging(
      `crewmate init: no roster for ${identity.crewName} — skipping allow rules and hooks`,
    )
    return
  }

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
    roster.members.find(member => member.agentId === roster.leadAgentId)?.name ?? CREW_LEAD_NAME

  if (identity.agentId === roster.leadAgentId) {
    logForDebugging('crewmate init: this agent IS the crew lead — no Stop hook registered')
    return
  }

  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '',
    async messages => {
      void setMemberActive(identity.crewName, identity.agentName, false)
      const summary = getLastPeerDmSummary(messages)
      const notification = createIdleNotification(identity.agentName, {
        idleReason: 'available',
        ...(summary !== undefined ? { summary } : {}),
      })
      const color = getCrewmateColor()
      await sendLiveMessage(undefined, {
      to: leadName,
      from: identity.agentName,
      text: JSON.stringify(notification),
      timestamp: new Date().toISOString(),
      ...(color !== undefined ? { color } : {}),
    })
      return true
    },
    'The crewmate idle notification could not be delivered',
    { timeout: 10_000, silent: true },
  )
}
