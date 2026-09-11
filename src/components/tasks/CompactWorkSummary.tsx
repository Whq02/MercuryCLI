import React, { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { compactSummaryHint } from '../mercury-ui/compactModeChip.js'
import { compactWorkSummaryText, useCompactWorkCounts } from './useFocusedWork.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { presentStripStops, stripKeyMapHintOf, subscribeSurfaceRoute } from '../../context/surfaceRoute.js'
import { escRungHint, escRungOf, type EscRungV1 } from '../../input-core/interruptArity.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../../services/engine-connector/focusedConnector.js'
import { hasSeatLive } from '../../services/engine-connector/seatLive.js'
import { useAppState, type AppState } from '../../state/AppState.js'
import { footerNoticeLine, noticeRowBlock, noticeRowText } from '../PromptInput/Notifications.js'

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

const subscribeFocusedSeat = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {},
)
function getFocusedEscRung(): EscRungV1 {
  const connector = getFocusedSessionConnector()
  if (!hasSeatLive(connector)) return 'idle'
  const status = connector.status()
  return escRungOf({ inFlight: connector.live().inFlight, interrupting: status.interrupting, hardStopping: status.hardStopping })
}
const getStripHint = (): string => stripKeyMapHintOf('repl', presentStripStops())
const noHint = (): string => ''

export function CompactWorkSummary({
  columns,
  focused,
  vimInsert = false,
  onFocus,
}: {
  columns: number
  focused: boolean
  vimInsert?: boolean
  onFocus: () => void
}): React.ReactNode {
  const counts = useCompactWorkCounts()
  const tokens = useMercuryTokens()
  const rung = useSyncExternalStore(subscribeFocusedSeat, getFocusedEscRung, getFocusedEscRung)
  const stripHint = useSyncExternalStore(subscribeSurfaceRoute, getStripHint, noHint)
  const hint = compactSummaryHint({ focused, vimInsert, escHint: escRungHint(rung), stripHint })
  const hintWidth = hint === '' ? 0 : stringWidth(hint) + 1
  const currentNotice = useAppState((state: AppState) => state.notifications.current)
  const noticeText = noticeRowText(currentNotice)
  const noticeBlock = noticeText === null ? noticeRowBlock(currentNotice) : null
  const noticeWidth = currentNotice !== null && !('jsx' in currentNotice) ? stringWidth(footerNoticeLine(currentNotice.text)) + 3 : 0
  return (
    <Box height={1} flexShrink={0} overflow="hidden" flexDirection="row">
      <Box flexGrow={1} minWidth={0} onClick={onFocus}>
        <Text wrap="truncate-end" bold={focused} color={focused ? tokens.textPrimary : tokens.textMuted} backgroundColor={focused ? tokens.selectionBand : undefined}>
          {compactWorkSummaryText(counts, Math.max(0, columns - hintWidth - noticeWidth))}
          {noticeText !== null ? (
            <Text>
              <Text color={tokens.textMuted}> · </Text>
              {noticeText}
            </Text>
          ) : null}
        </Text>
      </Box>
      {noticeBlock !== null ? (
        <Box flexShrink={1} minWidth={0} height={1} overflow="hidden">
          <Text color={tokens.textMuted}> · </Text>
          {noticeBlock}
        </Box>
      ) : null}
      {hint !== '' ? (
        <Box flexShrink={0} marginLeft={1}>
          <Text color={focused ? tokens.textSecondary : tokens.textMuted}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
