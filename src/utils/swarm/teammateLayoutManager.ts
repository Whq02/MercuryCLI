import { AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import { detectAndGetBackend } from './backends/registry.js'
import type { CreatePaneResult, PaneId } from './backends/types.js'

/**
 * Round-robin teammate colour assignment plus thin delegations to the
 * detected pane backend. The delegations resolve the backend through
 * detection on every call and hold no cache of their own — detection already
 * memoises its result.
 */

const colorAssignments = new Map<string, AgentColorName>()
let rotationIndex = 0

/** Stable per teammate id for the process lifetime; increments only on a new assignment. */
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

/** Used during team cleanup so a new team starts from the first colour again. */
export function clearTeammateColors(): void {
  colorAssignments.clear()
  rotationIndex = 0
}

/** Lazily imports the detection module and delegates. */
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
