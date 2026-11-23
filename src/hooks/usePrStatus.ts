import { useRef, useState } from 'react'
import { useTimer } from './effects.js'
import { fetchPrStatus, type PrReviewState } from '../utils/ghPrStatus.js'
import { getLastInteractionTime } from '../bootstrap/state.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { passedOver } from '../utils/passedOver.js'

const POLL_INTERVAL_MS = 60000
const IDLE_STOP_MS = 3600000
const SLOW_FETCH_DISABLE_MS = 4000

type PrStatusState = {
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
  enabled = true,
): PrStatusState {
  const [status, setStatus] = useState<PrStatusState>(EMPTY)
  const lastFetchStartRef = useRef<number | null>(null)
  const lastInteractionRef = useRef<number>(getLastInteractionTime())
  const disabledRef = useRef(false)

  useTimer(signal => {
    if (!enabled || disabledRef.current) return

    let timer: NodeJS.Timeout | null = null

    const run = async (): Promise<void> => {
      if (signal.aborted || disabledRef.current) return
      const interaction = getLastInteractionTime()
      if (
        interaction === lastInteractionRef.current &&
        Date.now() - interaction >= IDLE_STOP_MS
      ) {
        return
      }
      lastInteractionRef.current = interaction

      const startedAt = Date.now()
      lastFetchStartRef.current = startedAt
      let result: Awaited<ReturnType<typeof fetchPrStatus>>
      try {
        result = await fetchPrStatus()
      } catch (error) {
        passedOver(error)
        return
      }
      if (signal.aborted) return

      const endedAt = Date.now()
      if (endedAt - startedAt > SLOW_FETCH_DISABLE_MS) {
        disabledRef.current = true
        return
      }

      setStatus(prev => {
        const nextNumber = result ? result.number : null
        const nextReviewState = result ? result.reviewState : null
        if (prev.number === nextNumber && prev.reviewState === nextReviewState) {
          return prev
        }
        if (result === null) return EMPTY
        return {
          number: result.number,
          url: result.url,
          reviewState: result.reviewState,
          lastUpdatedAt: endedAt,
        }
      })

      schedule()
    }

    const schedule = (): void => {
      if (signal.aborted || disabledRef.current) return
      const delay =
        lastFetchStartRef.current === null
          ? 0
          : Math.max(0, POLL_INTERVAL_MS - (Date.now() - lastFetchStartRef.current))
      timer = startTimeout(() => {
        timer = null
        void run()
      }, delay)
      timer.unref?.()
    }

    schedule()

    return () => {
      if (timer !== null) stopTimeout(timer)
    }
  }, [enabled, isLoading])

  return status
}
