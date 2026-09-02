import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { InteractiveRow } from './InteractiveRow.js'
import { useMercuryTokens } from './useMercuryTokens.js'


export function railPanelPad(width: number): 0 | 1 {
  return width >= 28 ? 1 : 0
}

export function railPanelInnerWidth(width: number): number {
  return Math.max(8, width - 2 - 2 * railPanelPad(width))
}

export function RailPanel({
  glyph,
  label,
  count,
  width,
  children,
  headerAction,
}: {
  glyph: string
  label: string
  count?: string
  width: number
  children?: React.ReactNode
  headerAction?: { id: string; run: () => void }
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const headerHue = tokens.info
  const headerText = (hover: boolean): React.ReactNode => (
    <Text wrap="truncate-end">
      <Text color={hover ? 'infoShimmer' : headerHue}>{glyph} </Text>
      <Text color={hover ? 'infoShimmer' : headerHue} bold>
        {label}
      </Text>
      {count ? <Text color={tokens.textMuted}>{` · ${count}`}</Text> : null}
    </Text>
  )
  return (
    <Box
      width={width}
      flexDirection="column"
      flexShrink={0}
      borderStyle="round"
      borderColor={tokens.borderStrong}
      paddingX={railPanelPad(width)}
    >
      {headerAction ? (
        <InteractiveRow
          id={headerAction.id}
          directActivate
          onActivate={headerAction.run}
          width={railPanelInnerWidth(width)}
          height={1}
        >
          {headerText}
        </InteractiveRow>
      ) : (
        <Box width={railPanelInnerWidth(width)}>{headerText(false)}</Box>
      )}
      {children}
    </Box>
  )
}
