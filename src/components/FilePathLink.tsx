// Renders a path (or supplied children) as a file:// hyperlink — terminals
// then identify paths correctly even inside parentheses. The no-hyperlink
// fallback paints the SAME visible text as the link (the supplied children,
// else the path): a terminal without OSC 8 must not swap a display path for
// the absolute one.

import React from 'react'
import Link from '../ink/components/Link.js'

export function FilePathLink({
  filePath,
  children,
}: {
  filePath: string
  children?: React.ReactNode
}): React.ReactNode {
  const visible = children ?? filePath
  return (
    <Link url={`file://${filePath}`} fallback={visible}>
      {visible}
    </Link>
  )
}

export default FilePathLink
