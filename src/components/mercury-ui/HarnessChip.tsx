import * as React from 'react'
import { Text } from '../../ink.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js'
import { harnessEffortFact, resolveActiveHarnessProfile } from '../../services/mission/harnessApplication.js'
import type { HarnessProfileResolution } from '../../services/mission/harnessProfiles.js'


export function harnessChipLabel(resolution: HarnessProfileResolution | null): string | null {
  if (resolution === null) return null
  return ` · harness ${resolution.profileId}`
}

export function HarnessChip({ model, show }: { model: string; show: boolean }): React.ReactNode {
  const tok = useMercuryTokens()
  const effortValue = useAppStateMaybeOutsideOfProvider(s => s.effortValue)
  const label = harnessChipLabel(
    show ? resolveActiveHarnessProfile({ model, effortLevel: harnessEffortFact(model, effortValue) }) : null,
  )
  if (label === null) return null
  return <Text color={tok.textMuted}>{label}</Text>
}
