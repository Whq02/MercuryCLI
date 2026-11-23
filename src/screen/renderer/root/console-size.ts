import { passedOver } from '../../../platform/errors/passedOver.js'

type RefreshingStream = { _refreshSize?: unknown }

export function refreshConsoleSize(stdout: unknown): boolean {
  const refresh = (stdout as RefreshingStream | null | undefined)?._refreshSize
  if (typeof refresh !== 'function') return false
  try {
    ;(refresh as () => void).call(stdout)
  } catch (error) {
    passedOver(error)
  }
  return true
}
