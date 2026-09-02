
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
    if (!enabled || disabledForSessionRef.current) return
    let cancelled = false
    let timer: NodeJS.Timeout | null = null

    const poll = async (): Promise<void> => {
      if (cancelled || disabledForSessionRef.current) return

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
