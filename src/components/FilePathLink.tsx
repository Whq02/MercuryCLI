
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
