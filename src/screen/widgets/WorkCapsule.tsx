import * as React from 'react'
import { createContext } from 'react'
import { Box } from '../themedRenderer.js'
import { TerminalSizeContext } from '../renderer/elements/TerminalSizeContext.js'

export const WorkCapsuleContext = createContext<boolean>(false)

export function WorkCapsule({
  active,
  width,
  children,
}: {
  active: boolean
  width: number
  children: React.ReactNode
}): React.ReactNode {
  const outer = React.useContext(TerminalSizeContext)
  const sizeVal = React.useMemo(
    () => (active && outer ? { columns: width, rows: outer.rows } : outer),
    [active, outer, width],
  )
  return (
    <WorkCapsuleContext.Provider value={active}>
      <Box flexDirection="column" flexShrink={0} width={width}>
        <TerminalSizeContext.Provider value={sizeVal}>
          {children}
        </TerminalSizeContext.Provider>
      </Box>
    </WorkCapsuleContext.Provider>
  )
}
