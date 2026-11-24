
import React from 'react'
import { Box } from '../themedRenderer.js'
import { useIsInsideModal } from '../overlays/modalContext.js'
import { Panel } from '../widgets/components.js'

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
