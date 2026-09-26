import { getIsInteractive } from '../../bootstrap/state.js'
import { CLIENT_PRESENCE_BEAT_MS } from '../../daemon/clientPresence.js'
import { logForDebugging } from '../../utils/debug.js'

let beat: ReturnType<typeof setInterval> | null = null

export function screenPresenceFrame(pid: number = process.pid): { op: 'hello'; clientPid: number; clientKind: 'screen' } {
  return { op: 'hello', clientPid: pid, clientKind: 'screen' }
}

async function sendScreenPresence(): Promise<void> {
  try {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    await daemonControlRpc(screenPresenceFrame(), { timeoutMs: 1_000, protoRetry: false })
  } catch (err) {
    logForDebugging(`[screen-presence] beat not delivered: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function startScreenPresenceBeat(): boolean {
  if (beat !== null) return true
  if (!getIsInteractive()) return false
  void sendScreenPresence()
  beat = setInterval(() => void sendScreenPresence(), CLIENT_PRESENCE_BEAT_MS)
  beat.unref?.()
  return true
}

export function stopScreenPresenceBeat(): void {
  if (beat === null) return
  clearInterval(beat)
  beat = null
}

export function screenPresenceBeatArmed(): boolean {
  return beat !== null
}
