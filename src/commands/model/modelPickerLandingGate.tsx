import * as React from 'react'
import { useTimer } from '../../screen/effects/effects.js'
import { FAINT } from '../../screen/theme/mercuryPalette.js'
import { Text } from '../../screen/themedRenderer.js'
import { landingInFlight, subscribeFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export const MODEL_PICKER_LANDING_WORDS = 'the session is still landing — the model picker opens when it has'
export const MODEL_PICKER_LANDING_CEILING_MS = 4_000

export function MercuryModelLandingGate({
  children,
  ceilingMs = MODEL_PICKER_LANDING_CEILING_MS,
}: {
  children: React.ReactNode
  ceilingMs?: number
}): React.ReactNode {
  const landing = React.useSyncExternalStore(subscribeFocusedSessionConnector, landingInFlight, landingInFlight)
  const [ceilingPassed, setCeilingPassed] = React.useState(false)
  useTimer(() => {
    if (!landing || ceilingPassed) return
    const timer = startTimeout(() => setCeilingPassed(true), ceilingMs)
    return () => stopTimeout(timer)
  }, [landing, ceilingPassed, ceilingMs])
  if (landing && !ceilingPassed) return <Text color={FAINT}>{MODEL_PICKER_LANDING_WORDS}</Text>
  return <>{children}</>
}
