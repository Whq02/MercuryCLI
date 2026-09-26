import { formatLimit, type InactivityDeadline } from '../../utils/deadline.js'

export type HostAskLiveness = {
  noteParked(): void
  noteSettled(): void
  stop(): void
}

export function hostAskHeartbeatMs(limitMs: number): number {
  return Math.max(1_000, Math.min(30_000, Math.floor(limitMs / 4)))
}

export function unansweredWithinLimitCause(limitMs: number): string {
  return `nobody answered within ${formatLimit(limitMs)}, the turn's no-progress limit`
}

export function keepTurnLiveWhileHostAnswers(args: {
  watchdog: Pick<InactivityDeadline, 'touch' | 'armed'>
  limitMs: number
  parkedWithHost: () => number
  parkedAsks: () => number
  settleParkedAsks: (cause: string) => number
}): HostAskLiveness {
  const { watchdog, limitMs, parkedWithHost, parkedAsks, settleParkedAsks } = args
  if (!watchdog.armed) return { noteParked: () => {}, noteSettled: () => {}, stop: () => {} }
  let askClock: ReturnType<typeof setTimeout> | null = null
  const clearAskClock = (): void => {
    if (askClock === null) return
    clearTimeout(askClock)
    askClock = null
  }
  const settleAtLimit = (): void => {
    askClock = null
    if (parkedAsks() === 0) return
    if (settleParkedAsks(unansweredWithinLimitCause(limitMs)) > 0) watchdog.touch()
  }
  const armAskClock = (): void => {
    if (askClock !== null) return
    askClock = setTimeout(settleAtLimit, limitMs)
    askClock.unref?.()
  }
  const beat = setInterval(() => {
    if (parkedWithHost() > 0) watchdog.touch()
    if (parkedAsks() > 0) armAskClock()
    else clearAskClock()
  }, hostAskHeartbeatMs(limitMs))
  beat.unref?.()
  return {
    noteParked: () => {
      watchdog.touch()
      armAskClock()
    },
    noteSettled: () => {
      setTimeout(() => {
        if (parkedAsks() === 0) clearAskClock()
      }, 0)
    },
    stop: () => {
      clearInterval(beat)
      clearAskClock()
    },
  }
}
