import * as React from 'react'
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { Box, type DOMElement } from '../ink.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { closeCrewView, crewViewVersion, isCrewViewOpen, subscribeCrewView } from '../utils/cockpit/crewView.js'
import { estateGroundBg } from '../utils/mercuryTokens.js'
import { CrewView } from './mercury-ui/screens/CrewView.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { modelPickerPopupGeometry, modelPickerPopupHost, type ModelPickerPopupHost } from './ModelPickerPopupSlot.js'

export const CREW_POPUP_WIDTH = 124
export const CREW_POPUP_MIN_WIDTH = 60

export type CrewPopupGeometry = { left: number; top: number; width: number; rows: number }

export function crewPopupGeometry(host: ModelPickerPopupHost, terminalRows: number): CrewPopupGeometry {
  const shared = modelPickerPopupGeometry(host, terminalRows)
  const width = Math.min(CREW_POPUP_WIDTH, Math.max(CREW_POPUP_MIN_WIDTH, host.columns))
  const left = Math.max(0, Math.floor((host.columns - width) / 2))
  return { left, top: Math.max(0, shared.top - host.top), width, rows: shared.rows }
}

export function CrewViewSlot({ hostRef, framed }: { hostRef: React.RefObject<DOMElement | null>; framed: boolean }): React.ReactNode {
  useSyncExternalStore(subscribeCrewView, crewViewVersion, crewViewVersion)
  const tokens = useMercuryTokens()
  const { rows: terminalRows } = useTerminalSize()
  const open = isCrewViewOpen()
  const [host, setHost] = useState<ModelPickerPopupHost | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const element = hostRef.current
    if (!element) return
    const next = modelPickerPopupHost(element, framed)
    if (next === null) return
    if (host === null || host.left !== next.left || host.top !== next.top || host.columns !== next.columns || host.rows !== next.rows) setHost(next)
  })
  if (!open || host === null) return null
  const geometry = crewPopupGeometry(host, terminalRows)
  const ground = estateGroundBg(tokens)
  return (
    <Box
      position="absolute"
      top={geometry.top}
      left={geometry.left}
      width={geometry.width}
      flexDirection="column"
      flexShrink={0}
      opaque={true}
      {...(ground !== undefined ? { backgroundColor: ground } : {})}
    >
      <TerminalSizeContext.Provider value={{ columns: geometry.width - 4, rows: geometry.rows }}>
        <CrewView onClose={closeCrewView} popup />
      </TerminalSizeContext.Provider>
    </Box>
  )
}
