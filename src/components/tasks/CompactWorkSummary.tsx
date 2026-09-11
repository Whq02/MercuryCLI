import React, { useMemo, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { compactWorkSummaryText, useCompactWorkCounts } from './useFocusedWork.js'

export type CompactWorkFocus = 'composer' | 'summary' | 'detail'
export type CompactWorkControls = {
  read: () => CompactWorkFocus
  set: (focus: CompactWorkFocus) => void
  toggleSummary: () => void
  bindToggle: (handler: (() => void) | null) => void
  detailState: { selectedId: string | null; detailTaskId: string | undefined }
}

export function useCompactWorkControls(): { controls: CompactWorkControls; focus: CompactWorkFocus } {
  const current = useRef<CompactWorkFocus>('composer')
  const toggle = useRef<(() => void) | null>(null)
  const [focus, setFocus] = useState<CompactWorkFocus>('composer')
  const detailState = useRef<{ selectedId: string | null; detailTaskId: string | undefined }>({ selectedId: null, detailTaskId: undefined })
  const controls = useMemo<CompactWorkControls>(() => ({
    detailState: detailState.current,
    read: () => current.current,
    set: next => {
      if (current.current === next) return
      current.current = next
      if (next === 'composer') { detailState.current.selectedId = null; detailState.current.detailTaskId = undefined }
      setFocus(next)
    },
    toggleSummary: () => toggle.current?.(),
    bindToggle: handler => { toggle.current = handler },
  }), [])
  return { controls, focus }
}

export function CompactWorkSummary({
  columns,
  focused,
  onFocus,
}: {
  columns: number
  focused: boolean
  onFocus: () => void
}): React.ReactNode {
  const counts = useCompactWorkCounts()
  const tokens = useMercuryTokens()
  return (
    <Box height={1} flexShrink={0} overflow="hidden" onClick={onFocus}>
      <Text wrap="truncate-end" bold={focused} color={focused ? tokens.textPrimary : tokens.textMuted} backgroundColor={focused ? tokens.selectionBand : undefined}>
        {compactWorkSummaryText(counts, columns)}
      </Text>
    </Box>
  )
}
