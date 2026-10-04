
export function formatAgentId(agentName: string, crewName: string): string {
  return `${agentName}@${crewName}`
}

let requestIdSequence = 0

export function generateRequestId(requestType: string, agentId: string): string {
  requestIdSequence += 1
  return `${requestType}-${Date.now()}.${requestIdSequence.toString(36)}@${agentId}`
}
