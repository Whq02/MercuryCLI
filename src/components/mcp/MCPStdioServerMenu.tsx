// The stdio server detail menu: identity card + a small action menu. The
// toggle row is pushed unconditionally, so this menu is never empty; an stdio
// server in the needs-auth state reads as failed (stdio has no auth).

import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useMcpReconnect, useMcpToggleEnabled } from '../../services/mcp/MCPConnectionManager.js'
import { getToolDiscoveryFailure } from '../../services/mcp/client.js'
import { getMcpConfigByName } from '../../services/mcp/config.js'
import {
  describeMcpConfigFilePath,
  filterMcpPromptsByServer,
  filterResourcesByServer,
} from '../../services/mcp/utils.js'
import { useAppState } from '../../state/AppState.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../CustomSelect/select.js'
import { Spinner } from '../Spinner.js'
import { CapabilitiesSection } from './CapabilitiesSection.js'
import { describeReconnectOutcome } from './utils/reconnectHelpers.js'
import type { ServerInfo, StdioServerInfo } from './types.js'

function capitalise(name: string): string {
  return name.length > 0 ? name[0]!.toUpperCase() + name.slice(1) : name
}

export function MCPStdioServerMenu({
  server,
  serverToolsCount,
  onViewTools,
  onCancel,
  onComplete,
  borderless = false,
}: {
  server: ServerInfo
  /** Supplied by the host — the menu never re-counts. */
  serverToolsCount: number
  onViewTools: () => void
  /** One level back (the list), optionally carrying a tab hint. */
  onCancel: (tabHint?: string) => void
  /** A terminal action finished; the host shows the report. */
  onComplete: (result?: string) => void
  borderless?: boolean
}): React.ReactNode {
  const reconnect = useMcpReconnect()
  const toggle = useMcpToggleEnabled()
  const commands = useAppState(state => state.mcp.commands)
  const resources = useAppState(state => state.mcp.resources)

  const [waiting, setWaiting] = useState(false)
  const [resultLine, setResultLine] = useState<string | null>(null)
  const [errorLine, setErrorLine] = useState<string | null>(null)

  const client = server.client
  const disabled = client.type === 'disabled'
  const connected = client.type === 'connected'
  // stdio has no needs-auth state; it reads as failed.
  const status = client.type === 'needs-auth' ? 'failed' : client.type
  const toolCount = serverToolsCount
  const config = server.config as StdioServerInfo['config']

  // Two config-location reads on purpose: the config store may no longer
  // carry a server that is still connected — the fallback is the built-in
  // scope (the two reads can disagree).
  const storeEntry = getMcpConfigByName(server.name)
  const configLocation = describeMcpConfigFilePath(
    storeEntry?.scope ?? 'dynamic',
  )

  if (waiting) {
    return (
      <Box>
        <Spinner />
        <Text dimColor>
          {' '}
          Restarting the {server.name} process — this can take a moment…
        </Text>
      </Box>
    )
  }

  const options: Array<{ label: string; value: string }> = []
  if (!disabled && toolCount > 0) {
    options.push({ label: 'View tools', value: 'tools' })
  }
  if (!disabled) options.push({ label: 'Reconnect', value: 'reconnect' })
  // Pushed unconditionally: the stdio menu is never empty.
  options.push({
    label: disabled ? 'Enable' : 'Disable',
    value: 'toggle',
  })

  return (
    <Dialog
      title={capitalise(server.name)}
      onCancel={() => onCancel('mercury')}
      hideInputGuide
      hideBorder={borderless}
    >
      <Box flexDirection="column">
        <Text>
          <Text dimColor>Status: </Text>
          {status}
        </Text>
        {connected && toolCount === 0 && getToolDiscoveryFailure(server.name) !== null && (
          <Text color="yellow" wrap="truncate-end">
            tool discovery failed — {getToolDiscoveryFailure(server.name)?.message} (retried automatically; Reconnect retries now)
          </Text>
        )}
        <Text wrap="truncate-end">
          <Text dimColor>Command: </Text>
          {config.command}
          {config.args && config.args.length > 0
            ? ` ${config.args.join(' ')}`
            : ''}
        </Text>
        <Text>
          <Text dimColor>Config: </Text>
          {configLocation}
        </Text>
        {connected ? (
          <CapabilitiesSection
            toolCount={toolCount}
            resourceCount={filterResourcesByServer(resources[server.name] ?? [], server.name).length}
            promptCount={filterMcpPromptsByServer(commands, server.name).length}
          />
        ) : null}
        {client.type === 'failed' && client.error ? (
          <Text color="error">{client.error}</Text>
        ) : null}
        {resultLine ? <Text dimColor>{resultLine}</Text> : null}
        {errorLine ? <Text color="error">{errorLine}</Text> : null}
        <Select
          options={options}
          onChange={value => {
            if (value === 'tools') {
              onViewTools()
              return
            }
            if (value === 'reconnect') {
              setWaiting(true)
              setErrorLine(null)
              void reconnect(server.name)
                .then(result => {
                  setResultLine(
                    describeReconnectOutcome(server.name, result.client)
                      .message,
                  )
                })
                .catch(error => {
                  setErrorLine(
                    error instanceof Error ? error.message : String(error),
                  )
                })
                .finally(() => setWaiting(false))
              return
            }
            // Toggle, then return to the list so the operator can keep
            // managing other servers.
            const action = disabled ? 'enable' : 'disable'
            void toggle(server.name)
              .then(() => onComplete(`${action === 'enable' ? 'Enabled' : 'Disabled'} ${server.name}.`))
              .catch(error => {
                setErrorLine(
                  `Could not ${action} ${server.name}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                )
              })
          }}
          onCancel={() => onCancel('mercury')}
        />
        <Text dimColor>↑↓ navigate · ↵ select · esc back</Text>
      </Box>
    </Dialog>
  )
}
