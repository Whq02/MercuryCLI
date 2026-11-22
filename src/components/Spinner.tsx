import React, {
  useContext,
  useState,
  useSyncExternalStore,
} from 'react'
import { useClaim, useTimer } from '../hooks/effects.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { Box, Text } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useAppState } from '../state/AppState.js'
import { activityManager } from '../utils/activityManager.js'
import { getEffortSuffix } from '../utils/effort.js'
import { truncateKeepingTail } from '../utils/truncate.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import type { Theme } from '../utils/theme.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { GLYPH, truncateToWidth } from '../utils/glyphs.js'
import { sampleSpinnerVerb } from '../constants/spinnerVerbs.js'
import { WAITING_VERB } from '../utils/cockpit/toolVerb.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { WorkCapsuleContext } from './mercury-ui/WorkCapsule.js'
import { useNowTick } from './mercury-ui/components.js'
import { SpinnerAnimationRow } from './Spinner/SpinnerAnimationRow.js'
import { liveCounterLine, liveCounterPhaseOf, liveCounterWords, turnFactsOfRefs } from './Spinner/liveCounterWords.js'
import { useOutputRate } from './Spinner/useOutputRate.js'
import type { LiveTurnFactsV1 } from '../services/engine-connector/seatLive.js'
import { TaskListV2 } from './TaskListV2.js'
import type { SpinnerMode } from '../types/spinner.js'
import { useFocusedMission } from './tasks/useFocusedWork.js'
import { startInterval, stopInterval } from '../utils/timers.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

const WHIMSY_ROTATE_MS = 15_000
const LONG_TURN_TIP_MS = 30 * 60 * 1000

const subscribeFocusedSpinnerModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedSpinnerModel = (): string => getFocusedSessionConnector().modelFacts().main

type ThemeKey = keyof Theme

export type SpinnerWithVerbProps = Unbuilt

export function nextPendingTask<T extends { id: string; status: string; blockedBy?: readonly string[] }>(tasks: readonly T[]): T | undefined {
  const pending = tasks.filter(task => task.status === 'pending')
  const byId = new Map(tasks.map(task => [task.id, task]))
  const unblocked = pending.find(task =>
    (task.blockedBy ?? []).every(blocker => {
      const other = byId.get(blocker)
      return other === undefined || other.status === 'completed'
    }),
  )
  return unblocked ?? pending[0]
}

export function SpinnerWithVerb(arg0: SpinnerWithVerbProps): React.ReactNode {
  return notBuilt('src/components/Spinner.tsx:82')
}


const STAR_BASE = ['✶', '✸', '✹', '✺', '✹', '✷']
const STAR_FRAMES = [...STAR_BASE, ...[...STAR_BASE].reverse()]
const STAR_TICK_MS = 160

export function Spinner(): React.ReactNode {
  const reducedMotion =
    useAppState(state => state.settings.view?.reducedMotion === true) ||
    isEnvTruthy(flagEnv('MERCURY_REDUCED_MOTION'))
  useNowTick(reducedMotion ? null : STAR_TICK_MS)
  if (reducedMotion) {
    return <Text color="claude">● </Text>
  }
  const frame =
    STAR_FRAMES[Math.floor(Date.now() / STAR_TICK_MS) % STAR_FRAMES.length]
  return <Text color="claude">{frame} </Text>
}
