import { AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import { detectAndGetBackend } from './backends/registry.js'
import type { CreatePaneResult, PaneId } from './backends/types.js'


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

export async function isInsideTmux(): Promise<boolean> {
  const detection = await import('./backends/detection.js')
  return detection.isInsideTmux()
}

export async function createTeammatePaneInSwarmView(
  name: string,
  color: AgentColorName,
): Promise<CreatePaneResult> {
  const { backend } = await detectAndGetBackend()
  return backend.createTeammatePaneInSwarmView(name, color)
}

export async function enablePaneBorderStatus(
  windowTarget?: string,
  useSwarmSocket?: boolean,
): Promise<void> {
  const { backend } = await detectAndGetBackend()
  return backend.enablePaneBorderStatus(windowTarget, useSwarmSocket)
}

export async function sendCommandToPane(
  paneId: PaneId,
  command: string,
  useSwarmSocket?: boolean,
): Promise<void> {
  const { backend } = await detectAndGetBackend()
  return backend.sendCommandToPane(paneId, command, useSwarmSocket)
}
