import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { Text } from '../ink.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../services/engine-connector/focusedConnector.js'
import { hasSeatLive } from '../services/engine-connector/seatLive.js'
import { foldBarCells, foldRowWords, type FoldStatusV1 } from '../services/compact/foldStatus.js'
import { MessageResponse } from './MessageResponse.js'
import { WorkingGlyph } from './mercury-ui/LiveGlyphs.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useNowTick } from './mercury-ui/components.js'

const subscribeFocusedFold = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) && connector.subscribeFold !== undefined ? connector.subscribeFold(listener) : () => {},
)
const getFocusedFold = (): FoldStatusV1 | null => {
  const connector = getFocusedSessionConnector()
  return hasSeatLive(connector) && connector.fold !== undefined ? connector.fold() : null
}

export function FoldStatusRow(): React.ReactNode {
  const fold = useSyncExternalStore(subscribeFocusedFold, getFocusedFold, getFocusedFold)
  const live = fold !== null && fold.exit === undefined
  const nowMs = useNowTick(live ? 1000 : null)
  const tokens = useMercuryTokens()
  if (fold === null) return null
  const words = foldRowWords(fold, nowMs)
  const cells = foldBarCells(fold)
  const lead = [words.head, words.stage, words.tokens].filter((part): part is string => part !== null).join(' · ')
  return (
    <MessageResponse height={1}>
      <Text dimColor>{lead} · </Text>
      {cells.map((cell, index) =>
        cell === 'pulse' ? (
          <WorkingGlyph key={index} color={tokens.textSecondary} active={live} />
        ) : cell === 'empty' ? (
          <Text key={index} color={tokens.textMuted}>
            {GLYPH.barEmpty}
          </Text>
        ) : (
          <Text key={index} color={cell === 'done' ? tokens.textSecondary : tokens.accent}>
            {GLYPH.barFull}
          </Text>
        ),
      )}
      <Text dimColor> · {words.elapsed}</Text>
    </MessageResponse>
  )
}

export default FoldStatusRow
