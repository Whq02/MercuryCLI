
export function formatAgentId(agentName: string, teamName: string): string {
  return `${agentName}@${teamName}`
}

export function parseAgentId(agentId: string): { agentName: string; teamName: string } | null {
  const separator = agentId.indexOf('@')
  if (separator === -1) return null
  return {
    agentName: agentId.slice(0, separator),
    teamName: agentId.slice(separator + 1),
  }
}

let requestIdSequence = 0

export function generateRequestId(requestType: string, agentId: string): string {
  requestIdSequence += 1
  return `${requestType}-${Date.now()}.${requestIdSequence.toString(36)}@${agentId}`
}

export function parseRequestId(
  requestId: string,
): { requestType: string; timestamp: number; agentId: string } | null {
  const at = requestId.indexOf('@')
  if (at === -1) return null
  const prefix = requestId.slice(0, at)
  const agentId = requestId.slice(at + 1)
  const hyphen = prefix.lastIndexOf('-')
  if (hyphen === -1) return null
  const requestType = prefix.slice(0, hyphen)
  const timestamp = parseInt(prefix.slice(hyphen + 1), 10)
  if (Number.isNaN(timestamp)) return null
  return { requestType, timestamp, agentId }
}
