import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { Text } from '../../ink.js'
import { AMBER } from '../mercuryPalette.js'
import { capFailoverLaneOf, getCapHandoffVersion, subscribeCapHandoff } from '../../services/capFailover.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import { useFocusedServedModel } from '../../hooks/useDisplayedSessionModel.js'

export const FAILOVER_MARK = 'failover'

export function failoverMarkFor(model: string): string | null {
  return capFailoverLaneOf(declaredRouteOf(model)) === null ? null : FAILOVER_MARK
}

export function FailoverMark({ model }: { model: string }): React.ReactNode {
  useSyncExternalStore(subscribeCapHandoff, getCapHandoffVersion, getCapHandoffVersion)
  const served = useFocusedServedModel()
  const mark = failoverMarkFor(served ?? model)
  if (mark === null) return null
  return <Text color={AMBER}> · {mark}</Text>
}
