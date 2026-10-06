import { getCrewmateContext } from './crewmateContext.js'


export {
  createCrewmateContext,
  getCrewmateContext,
  isInProcessCrewmate,
  runWithCrewmateContext,
} from './crewmateContext.js'
export type { CrewmateContext } from './crewmateContext.js'

export type DynamicCrewContext = {
  agentId: string
  agentName: string
  crewName: string
  color?: string
  parentSessionId?: string
}

let dynamicCrewContext: DynamicCrewContext | null = null

export function setDynamicCrewContext(context: DynamicCrewContext | null): void {
  dynamicCrewContext = context
}

export function clearDynamicCrewContext(): void {
  dynamicCrewContext = null
}

export function getDynamicCrewContext(): DynamicCrewContext | null {
  return dynamicCrewContext
}

export function getParentSessionId(): string | undefined {
  const context = getCrewmateContext()
  if (context) return context.parentSessionId
  return dynamicCrewContext?.parentSessionId
}

export function getAgentId(): string | undefined {
  const context = getCrewmateContext()
  if (context) return context.agentId
  return dynamicCrewContext?.agentId
}

export function getAgentName(): string | undefined {
  const context = getCrewmateContext()
  if (context) return context.agentName
  return dynamicCrewContext?.agentName
}

export function getCrewmateColor(): string | undefined {
  const context = getCrewmateContext()
  if (context) return context.color
  return dynamicCrewContext?.color
}

export function getCrewName(crewContext?: { crewName: string }): string | undefined {
  const context = getCrewmateContext()
  if (context) return context.crewName
  if (dynamicCrewContext && dynamicCrewContext.crewName !== '') return dynamicCrewContext.crewName
  return crewContext?.crewName
}

let leadCrewFallback: string | null = null

export function setLeadCrewFallback(crewName: string | null): void {
  leadCrewFallback = crewName
}

export function getLeadCrewFallback(): string | null {
  return leadCrewFallback
}

export function resolveLeadAwareCrewName(crewContext?: { crewName: string }): string | undefined {
  return getCrewName(crewContext) ?? leadCrewFallback ?? undefined
}

export function isCrewmate(): boolean {
  if (getCrewmateContext() !== undefined) return true
  return (
    dynamicCrewContext !== null &&
    dynamicCrewContext.agentId !== '' &&
    dynamicCrewContext.crewName !== ''
  )
}


export function isCrewLead(crewContext: { leadAgentId: string } | undefined): boolean {
  if (!crewContext?.leadAgentId) return false
  const agentId = getAgentId()
  if (agentId === undefined) return true
  return agentId === crewContext.leadAgentId
}
