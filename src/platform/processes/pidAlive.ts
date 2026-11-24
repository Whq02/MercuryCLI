import { passedOver } from '../errors/passedOver.js'
import { isRecord } from '../primitives/isRecord.js'

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
    if (code === 'EPERM') return true
    if (code !== 'ESRCH') passedOver(error)
    return false
  }
}
