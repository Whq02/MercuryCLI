import type * as React from 'react'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { openFilesMenu } from '../../utils/cockpit/filesMenu.js'

export async function call(onDone: LocalJSXCommandOnDone, _context: LocalJSXCommandContext, _args: string): Promise<React.ReactNode> {
  openFilesMenu()
  onDone(undefined, { display: 'skip' })
  return null
}
