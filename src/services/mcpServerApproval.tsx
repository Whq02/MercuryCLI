import * as React from 'react'

import { MCPServerApprovalDialog } from '../components/MCPServerApprovalDialog.js'
import { MCPServerMultiselectDialog } from '../components/MCPServerMultiselectDialog.js'
import type { Root } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import { getProjectMcpConfigsFromCwd } from './mcp/config.js'
import { getProjectMcpServerStatus } from './mcp/utils.js'

/**
 * Boot-time gate: renders the project-`.mcp.json` server approval flow on
 * the EXISTING Ink root (never a second root) and resolves when the
 * dialog signals completion, so boot blocks until the user decides.
 */
export async function handleMcpjsonServerApprovals(root: Root): Promise<void> {
  const { servers } = getProjectMcpConfigsFromCwd()
  const pending = Object.keys(servers).filter(
    name => getProjectMcpServerStatus(name) === 'pending',
  )
  if (pending.length === 0) return
  await new Promise<void>(resolve => {
    const dialog =
      pending.length === 1 ? (
        <MCPServerApprovalDialog serverName={pending[0] as string} onDone={() => resolve()} />
      ) : (
        <MCPServerMultiselectDialog serverNames={pending} onDone={() => resolve()} />
      )
    root.render(
      <AppStateProvider>
        <KeybindingSetup>{dialog}</KeybindingSetup>
      </AppStateProvider>,
    )
  })
}
