import * as React from 'react'
import { McpPopup } from '../../commands/mcp/McpPopup.js'
import type { LocalJSXCommandOnDone } from '../../commands/catalogue/command.js'

export function MCPSettings({ onComplete }: { onComplete: LocalJSXCommandOnDone }): React.ReactNode {
  return <McpPopup onDone={() => onComplete(undefined, { display: 'skip' })} />
}
