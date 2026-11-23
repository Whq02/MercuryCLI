import { getProcessStartTokenCachedOrRefresh } from '../../daemon/control/ownerWatch.js'
import { passedOver } from '../errors/passedOver.js'

export function pidAlive(pid: number, startToken?: string): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ESRCH') return false
    if (code !== 'EPERM') {
      passedOver(error)
      return false
    }
  }
  if (!startToken) return true
  const live = getProcessStartTokenCachedOrRefresh(pid, undefined, startToken)
  return live === null || live === startToken
}
