import * as React from 'react'
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Box, measureElement, type DOMElement } from '../ink.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import { closeCrewView, crewViewVersion, isCrewViewOpen, subscribeCrewView } from '../utils/cockpit/crewView.js'
import { estateGroundBg } from '../utils/mercuryTokens.js'
import { CrewView } from './mercury-ui/screens/CrewView.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'

export const CREW_POPUP_WIDTH = 124
export const CREW_POPUP_MIN_WIDTH = 60
export const CREW_POPUP_CHROME_ROWS = 6

export type CrewPopupGeometry = { left: number; top: number; width: number; rows: number }

export function crewPopupGeometry(cols: number, rows: number, height: number | null): CrewPopupGeometry {
  const width = Math.min(CREW_POPUP_WIDTH, Math.max(CREW_POPUP_MIN_WIDTH, cols))
  const left = Math.max(0, Math.floor((cols - width) / 2))
  const budget = Math.max(CREW_POPUP_CHROME_ROWS + 1, rows)
  const top = height === null ? 0 : Math.max(0, Math.floor((rows - Math.min(height, rows)) / 2))
  return { left, top, width, rows: budget }
}

export function CrewViewSlot({ hostRef, framed }: { hostRef: React.RefObject<DOMElement | null>; framed: boolean }): React.ReactNode {
  useSyncExternalStore(subscribeCrewView, crewViewVersion, crewViewVersion)
  const tokens = useMercuryTokens()
  const open = isCrewViewOpen()
  const slotRef = useRef<DOMElement | null>(null)
  const [host, setHost] = useState<{ columns: number; rows: number } | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const element = hostRef.current
    if (!element) return
    const measured = measureElement(element)
    if (measured.width <= 0 || measured.height <= 0) return
    if (host === null || host.columns !== measured.width || host.rows !== measured.height) {
      setHost({ columns: measured.width, rows: measured.height })
    }
    const slot = slotRef.current
    if (!slot) return
    const own = measureElement(slot).height
    if (own > 0 && own !== height) setHeight(own)
  })
  if (!open || host === null) return null
  const inset = framed ? 1 : 0
  const geometry = crewPopupGeometry(host.columns - 2 * inset, host.rows - 2 * inset, height)
  const ground = estateGroundBg(tokens)
  return (
    <Box
      ref={slotRef}
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
