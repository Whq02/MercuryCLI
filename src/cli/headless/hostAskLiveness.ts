import type { InactivityDeadline } from '../../utils/deadline.js'

export type HostAskLiveness = {
  noteParked(): void
  stop(): void
}

export function hostAskHeartbeatMs(limitMs: number): number {
  return Math.max(1_000, Math.min(30_000, Math.floor(limitMs / 4)))
}

export function keepTurnLiveWhileHostAnswers(args: {
  watchdog: Pick<InactivityDeadline, 'touch' | 'armed'>
  limitMs: number
  parkedWithHost: () => number
}): HostAskLiveness {
  const { watchdog, limitMs, parkedWithHost } = args
  if (!watchdog.armed) return { noteParked: () => {}, stop: () => {} }
  const beat = setInterval(() => {
    if (parkedWithHost() > 0) watchdog.touch()
  }, hostAskHeartbeatMs(limitMs))
  beat.unref?.()
  return {
    noteParked: () => watchdog.touch(),
    stop: () => clearInterval(beat),
  }
}
