export const DAEMON_CLIENT_BEAT_MS = 5_000

export type DaemonClientBeat = { pid: number; beats: () => number; stop: () => void }

export function startDaemonClientBeat(intervalMs: number = DAEMON_CLIENT_BEAT_MS): DaemonClientBeat {
  let beats = 0
  let stopped = false
  const send = async (): Promise<void> => {
    if (stopped) return
    try {
      const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
      const reply = (await daemonControlRpc({ op: 'hello', clientPid: process.pid, clientKind: 'client' } as never, { timeoutMs: 1_000, protoRetry: false })) as { ok?: boolean }
      if (reply.ok === true) beats++
    } catch {
    }
  }
  void send()
  const timer = setInterval(() => void send(), intervalMs)
  timer.unref?.()
  return {
    pid: process.pid,
    beats: () => beats,
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
