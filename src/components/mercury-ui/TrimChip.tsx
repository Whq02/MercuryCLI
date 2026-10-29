
import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { Text } from '../../ink.js'
import {
  getTrimChipSnapshot,
  subscribeTrimChip,
} from '../../services/instructions/effectiveSize.js'
import { FAINT } from '../mercuryPalette.js'
import { useMercuryTokens } from './useMercuryTokens.js'

export function trimChipText(guide: string): string {
  return `trim ${guide.toLowerCase()} to optimise performance and reduce context bloat`
}

export function TrimChip(): React.ReactNode {
  const snap = useSyncExternalStore(
    subscribeTrimChip,
    getTrimChipSnapshot,
    getTrimChipSnapshot,
  )
  const tokens = useMercuryTokens()
  if (!snap.armed) return null
  return (
    <Text>
      <Text color={FAINT}> · </Text>
      <Text color={tokens.warning}>{trimChipText(snap.guide)}</Text>
    </Text>
  )
}
