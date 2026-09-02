import { getProcessStartTokenCachedOrRefresh } from '../daemon/ownerWatch.js'

export function pidAlive(pid: number, startToken?: string): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (!startToken) return true
  const live = getProcessStartTokenCachedOrRefresh(pid)
  return live === null || live === startToken
}
