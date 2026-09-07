import * as React from 'react'
import { FAINT } from '../../components/mercuryPalette.js'
import { Text } from '../../ink.js'
import { landingInFlight, subscribeFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'

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
  React.useEffect(() => {
    if (!landing || ceilingPassed) return
    const timer = setTimeout(() => setCeilingPassed(true), ceilingMs)
    return () => clearTimeout(timer)
  }, [landing, ceilingPassed, ceilingMs])
  if (landing && !ceilingPassed) return <Text color={FAINT}>{MODEL_PICKER_LANDING_WORDS}</Text>
  return <>{children}</>
}
