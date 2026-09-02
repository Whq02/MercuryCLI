// Unwraps background-bash stdout/stderr from their transcript tags and
// hands them to the Bash tool's own result renderer. When stdout itself
// wraps a persisted-output payload, the inner payload wins.

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
  // stderr was escapeXml'd into its tag at write (so its own bytes can't
  // break the wrapper); restore them for display, or `&`/`<`/`>` render as
  // literal entities. stdout is stored unescaped, so it passes straight
  // through.
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
