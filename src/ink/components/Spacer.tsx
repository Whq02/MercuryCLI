// A box that fills the available space along the containing layout's major
// axis. The element is a stable singleton.

import React from 'react'
import Box from './Box.js'

const spacer = <Box flexGrow={1} />

export default function Spacer(): React.ReactNode {
  return spacer
}
