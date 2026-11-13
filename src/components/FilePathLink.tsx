
import { pathToFileURL } from 'node:url'
import React from 'react'
import Link from '../ink/components/Link.js'
import { isRemotePath } from '../services/remoteFiles/target.js'

export function FilePathLink({
  filePath,
  children,
}: {
  filePath: string
  children?: React.ReactNode
}): React.ReactNode {
  const visible = children ?? filePath
  if (isRemotePath(filePath)) return <>{visible}</>
  return (
    <Link url={pathToFileURL(filePath).href} fallback={visible}>
      {visible}
    </Link>
  )
}

export default FilePathLink
