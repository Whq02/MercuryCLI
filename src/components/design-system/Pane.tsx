// The dialog-estate seam. Inside a modal context the modal supplies the
// frame, so the pane is the modal-nested plain column (the product Panel:
// one column of horizontal padding, the structural left hairline, no card).
// Otherwise it is the rounded product card: one row of top gap and a border
// carrying the role colour. The width arithmetic is deliberate — a border
// column plus one padding column occupies exactly what two padding columns
// did before, so children keep the same usable width and only the
// height grows, by one row. The caller's role colour stays the border tint:
// a dangerous dialog keeps its error-coloured frame.

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
