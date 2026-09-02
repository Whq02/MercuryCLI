// Pull-request footer status. Polls every 60 s while the session is
// active. The next-poll delay is computed from the PREVIOUS fetch time, not
// from now — turn boundaries re-run the effect and must not spawn the gh
// tool more often than once per interval. Idleness is judged inside the
// poll (interaction timestamp unchanged for an hour ⇒ stop rescheduling;
// the next turn boundary restarts). A single slow fetch (>4 s) disables
// polling PERMANENTLY for the session; the flag is read at effect setup so
// later turns do not revive it. Identity-preserving updates keep unchanged
// polls render-free.

import { useEffect, useRef, useState } from 'react'
import { fetchPrStatus, type PrReviewState } from '../utils/ghPrStatus.js'
import { getLastInteractionTime } from '../bootstrap/state.js'

const POLL_INTERVAL_MS = 60000
const IDLE_STOP_MS = 3600000
const SLOW_FETCH_DISABLE_MS = 4000

export type PrStatusState = {
  number: number | null
  url: string | null
  reviewState: PrReviewState | null
  lastUpdatedAt: number
}

const EMPTY: PrStatusState = {
  number: null,
  url: null,
  reviewState: null,
  lastUpdatedAt: 0,
}

export function usePrStatus(
  isLoading: boolean,
  enabled: boolean = true,
): PrStatusState {
  const [status, setStatus] = useState<PrStatusState>(EMPTY)
  const lastFetchAtRef = useRef(0)
  const lastSeenInteractionRef = useRef(getLastInteractionTime())
  const disabledForSessionRef = useRef(false)

  useEffect(() => {
    // Checked at setup: a slow fetch earlier in the session stays fatal.
    if (!enabled || disabledForSessionRef.current) return
    let cancelled = false
    let timer: NodeJS.Timeout | null = null

    const poll = async (): Promise<void> => {
      if (cancelled || disabledForSessionRef.current) return

      // Idleness: unchanged interaction timestamp for an hour ends the
      // loop with no timer; a later turn boundary restarts it.
      const interactionNow = getLastInteractionTime()
      if (
        interactionNow === lastSeenInteractionRef.current &&
        Date.now() - interactionNow >= IDLE_STOP_MS
      ) {
        return
      }
      lastSeenInteractionRef.current = interactionNow

      const startedAt = Date.now()
      lastFetchAtRef.current = startedAt
      const fetched = await fetchPrStatus()
      const tookMs = Date.now() - startedAt
      if (tookMs > SLOW_FETCH_DISABLE_MS) {
        disabledForSessionRef.current = true
        return
      }
      if (cancelled) return
      setStatus(prev => {
        const next: PrStatusState = fetched
          ? {
              number: fetched.number,
              url: fetched.url,
              reviewState: fetched.reviewState,
              lastUpdatedAt: Date.now(),
            }
          : { ...EMPTY }
        // Identity-preserving when neither number nor review state changed.
        if (
          prev.number === next.number &&
          prev.reviewState === next.reviewState
        ) {
          return prev
        }
        return next
      })
      schedule()
    }

    const schedule = (): void => {
      if (cancelled || disabledForSessionRef.current) return
      // Delay from the PREVIOUS fetch; a fully elapsed interval polls now.
      const sinceLast = Date.now() - lastFetchAtRef.current
      const delay = Math.max(0, POLL_INTERVAL_MS - sinceLast)
      timer = setTimeout(() => void poll(), delay)
      timer.unref?.()
    }

    schedule()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [isLoading, enabled])

  return status
}
