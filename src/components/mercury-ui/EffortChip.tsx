
import * as React from 'react'
import { Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js'
import { useFocusedSentEffort, useFocusedServedEffort } from '../../hooks/useDisplayedSessionModel.js'
import {
  convertEffortValueToLevel,
  getDisplayedEffortLabel,
  getDisplayedEffortLevel,
  modelSupportsEffort,
  parseEffortValue,
  resolveStampedEffortTruth,
} from '../../utils/effort.js'
import { FAINT, SECOND } from '../mercuryPalette.js'
import { effortLevelToSymbol } from '../EffortIndicator.js'
import { useMercuryTokens } from './useMercuryTokens.js'

export function EffortChip({ model }: { model: string }): React.ReactNode {
  const effortValue = useAppStateMaybeOutsideOfProvider(s => s.effortValue)
  const supercode = useAppStateMaybeOutsideOfProvider(s => s.supercode)
  const seatEffort = useFocusedServedEffort()
  const sentEffort = useFocusedSentEffort()
  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  if (!model || !modelSupportsEffort(model)) return null
  const stamped = seatEffort !== null ? parseEffortValue(seatEffort) : undefined
  const seatResolution = stamped !== undefined ? resolveStampedEffortTruth(model, stamped) : null
  const sent = sentEffort !== null ? parseEffortValue(sentEffort) : undefined
  const level =
    sent !== undefined
      ? convertEffortValueToLevel(sent)
      : seatResolution !== null
        ? seatResolution.appliedValue !== undefined
          ? convertEffortValueToLevel(seatResolution.appliedValue)
          : getDisplayedEffortLevel(model, undefined)
        : getDisplayedEffortLevel(model, effortValue)
  const label = sentEffort ?? (seatResolution !== null ? seatResolution.label : getDisplayedEffortLabel(model, effortValue))
  return (
    <Text>
      <Text color={FAINT}> · </Text>
      {supercode && columns >= 100 ? (
        <>
          <Text color={tokens.info}>supercode</Text>
          <Text color={FAINT}> · </Text>
        </>
      ) : null}
      <Text color={FAINT}>{effortLevelToSymbol(level)} </Text>
      <Text color={SECOND}>{label}</Text>
    </Text>
  )
}
