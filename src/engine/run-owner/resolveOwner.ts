
import { getOriginalCwd, getSessionId } from '../../boot/process-state/processState.js'
import { getCrewmateContext } from '../../crew/agents/crewmateContext.js'
import {
  agentLane,
  MAIN_LANE,
  makeOwnerKey,
  type OwnerKey,
} from './ownerKey.js'
import { passedOver } from '../../platform/errors/passedOver.js'

function safeWorkspace(): string {
  try {
    return getOriginalCwd()
  } catch {
    return process.cwd()
  }
}

function safeSessionId(): string {
  try {
    return String(getSessionId())
  } catch (error) {
    passedOver(error)
    return 'boot'
  }
}

export function processMainOwner(): OwnerKey {
  return makeOwnerKey({
    workspace: safeWorkspace(),
    sessionId: safeSessionId(),
    lane: MAIN_LANE,
  })
}

export function mainOwnerOfSession(sessionId: string): OwnerKey {
  return makeOwnerKey({
    workspace: safeWorkspace(),
    sessionId,
    lane: MAIN_LANE,
  })
}

export function processOwnerForLane(agentId?: string | null): OwnerKey {
  return makeOwnerKey({
    workspace: safeWorkspace(),
    sessionId: safeSessionId(),
    lane: agentId ? agentLane(String(agentId)) : MAIN_LANE,
  })
}

export function currentOwner(): OwnerKey {
  return processOwnerForLane(getCrewmateContext()?.agentId)
}

export function ownerFromToolUseContext(context: {
  owner?: OwnerKey
  agentId?: string
}): OwnerKey {
  if (context.owner) return context.owner
  return processOwnerForLane(context.agentId ?? null)
}

export function rosterOwnerFromToolUseContext(context: {
  owner?: OwnerKey
  agentId?: string
  rosterOwner?: OwnerKey
}): OwnerKey {
  return context.rosterOwner ?? ownerFromToolUseContext(context)
}
