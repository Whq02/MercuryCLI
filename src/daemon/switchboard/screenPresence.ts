import { getIsInteractive } from '../../boot/process-state/processState.js'
import { CLIENT_PRESENCE_BEAT_MS } from '../control/clientPresence.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { startInterval, stopInterval } from '../../platform/async/timers.js'

let beat: ReturnType<typeof setInterval> | null = null

export function screenPresenceFrame(pid: number = process.pid): { op: 'hello'; clientPid: number; clientKind: 'screen' } {
  return { op: 'hello', clientPid: pid, clientKind: 'screen' }
}

async function sendScreenPresence(): Promise<void> {
  try {
    const { daemonControlRpc } = await import('../control/controlSocket.js')
    await daemonControlRpc(screenPresenceFrame(), { timeoutMs: 1_000, protoRetry: false })
  } catch (err) {
    logForDebugging(`[screen-presence] beat not delivered: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function startScreenPresenceBeat(): boolean {
  if (beat !== null) return true
  if (!getIsInteractive()) return false
  void sendScreenPresence()
  beat = startInterval(() => void sendScreenPresence(), CLIENT_PRESENCE_BEAT_MS)
  beat.unref?.()
  return true
}

export function stopScreenPresenceBeat(): void {
  if (beat === null) return
  stopInterval(beat)
  beat = null
}

export function screenPresenceBeatArmed(): boolean {
  return beat !== null
}
