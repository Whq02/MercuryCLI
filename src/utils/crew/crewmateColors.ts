import { AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js'

const colorAssignments = new Map<string, AgentColorName>()
let rotationIndex = 0

export function assignTeammateColor(teammateId: string): AgentColorName {
  const existing = colorAssignments.get(teammateId)
  if (existing !== undefined) return existing
  const color = AGENT_COLORS[rotationIndex % AGENT_COLORS.length] as AgentColorName
  rotationIndex += 1
  colorAssignments.set(teammateId, color)
  return color
}

export function getTeammateColor(teammateId: string): AgentColorName | undefined {
  return colorAssignments.get(teammateId)
}

export function clearTeammateColors(): void {
  colorAssignments.clear()
  rotationIndex = 0
}
