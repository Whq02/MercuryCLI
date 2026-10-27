import { MCPServerApprovalDialog } from '../components/MCPServerApprovalDialog.js'
import { MCPServerMultiselectDialog } from '../components/MCPServerMultiselectDialog.js'
import type { Root } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import { getProjectMcpConfigsFromCwd } from './mcp/config.js'
import type { ScopedMcpServerConfig } from './mcp/types.js'
import { getProjectMcpServerStatus } from './mcp/utils.js'

export async function handleProjectMcpServerApprovals(root: Root): Promise<void> {
  const { servers } = getProjectMcpConfigsFromCwd()
  const pending: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    if (getProjectMcpServerStatus(name, config) === 'pending') pending[name] = config
  }
  const names = Object.keys(pending)
  if (names.length === 0) return
  await new Promise<void>(resolve => {
    const dialog =
      names.length === 1 ? (
        <MCPServerApprovalDialog serverName={names[0] as string} config={pending[names[0] as string] as ScopedMcpServerConfig} onDone={() => resolve()} />
      ) : (
        <MCPServerMultiselectDialog serverNames={names} configs={pending} onDone={() => resolve()} />
      )
    root.render(
      <AppStateProvider>
        <KeybindingSetup>{dialog}</KeybindingSetup>
      </AppStateProvider>,
    )
  })
}
