export function agentStatusWord(status: string): string {
  return status === 'killed' ? 'stopped' : status
}
