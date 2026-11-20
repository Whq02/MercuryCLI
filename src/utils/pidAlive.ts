import { getProcessStartTokenCachedOrRefresh } from '../daemon/ownerWatch.js'
import { passedOver } from './passedOver.js'

export function pidAlive(pid: number, startToken?: string): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    passedOver(error)
    return false
  }
  if (!startToken) return true
  const live = getProcessStartTokenCachedOrRefresh(pid, undefined, startToken)
  return live === null || live === startToken
}
