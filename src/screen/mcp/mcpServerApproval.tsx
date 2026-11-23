import { MCPServerApprovalDialog } from './MCPServerApprovalDialog.js'
import { MCPServerMultiselectDialog } from './MCPServerMultiselectDialog.js'
import type { Root } from '../themedRenderer.js'
import { KeybindingSetup } from '../keys/KeybindingProviderSetup.js'
import { AppStateProvider } from '../app-state/AppState.js'
import { getProjectMcpConfigsFromCwd } from '../../integrations/mcp/serverConfigs.js'
import type { ScopedMcpServerConfig } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import { getProjectMcpServerStatus } from '../../integrations/mcp/utils.js'

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
