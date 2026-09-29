import { AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js'

const colorAssignments = new Map<string, AgentColorName>()
let rotationIndex = 0

export function assignCrewmateColor(crewmateId: string): AgentColorName {
  const existing = colorAssignments.get(crewmateId)
  if (existing !== undefined) return existing
  const color = AGENT_COLORS[rotationIndex % AGENT_COLORS.length] as AgentColorName
  rotationIndex += 1
  colorAssignments.set(crewmateId, color)
  return color
}

export function getCrewmateColor(crewmateId: string): AgentColorName | undefined {
  return colorAssignments.get(crewmateId)
}

export function clearCrewmateColors(): void {
  colorAssignments.clear()
  rotationIndex = 0
}
