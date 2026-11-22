import { useRef, useState } from 'react'
import { useTimer } from './effects.js'
import { fetchPrStatus, type PrReviewState } from '../utils/ghPrStatus.js'
import { getLastInteractionTime } from '../bootstrap/state.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

const POLL_INTERVAL_MS = 60000
const IDLE_STOP_MS = 3600000
const SLOW_FETCH_DISABLE_MS = 4000

type PrStatusState = Unbuilt

export function usePrStatus(
  isLoading: boolean,
  enabled?: boolean,
): PrStatusState {
  return notBuilt('src/hooks/usePrStatus.ts:26')
}
