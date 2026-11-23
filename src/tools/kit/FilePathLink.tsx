
import { pathToFileURL } from 'node:url'
import React from 'react'
import Link from '../../screen/renderer/elements/Link.js'
import { isRemotePath } from '../../platform/remote-file-target/target.js'

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
