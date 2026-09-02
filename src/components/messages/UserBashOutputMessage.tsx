
import React from 'react'
import BashToolResultMessage from '../../tools/BashTool/BashToolResultMessage.js'
import { extractTag } from '../../utils/messages.js'
import { unescapeXml } from '../../utils/xml.js'

export function UserBashOutputMessage({
  content,
  verbose,
}: {
  content: string
  verbose: boolean
}): React.ReactNode {
  let stdout = extractTag(content, 'bash-stdout') ?? ''
  const stderr = unescapeXml(extractTag(content, 'bash-stderr') ?? '')
  const persisted = extractTag(stdout, 'persisted-output')
  if (persisted !== null) stdout = persisted
  return (
    <BashToolResultMessage
      content={{ stdout, stderr }}
      verbose={verbose}
    />
  )
}

export default UserBashOutputMessage
