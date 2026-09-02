
import React from 'react'
import { Box } from '../../ink.js'
import { useIsInsideModal } from '../../context/modalContext.js'
import { Panel } from '../mercury-ui/components.js'

export function Pane({
  children,
  color = 'info',
}: {
  children?: React.ReactNode
  color?: string
}): React.ReactNode {
  const isInsideModal = useIsInsideModal()
  if (isInsideModal) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Panel>{children}</Panel>
      </Box>
    )
  }
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={color}
      paddingX={1}
    >
      {children}
    </Box>
  )
}

export default Pane
