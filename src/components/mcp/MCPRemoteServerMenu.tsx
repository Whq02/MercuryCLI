// The remote (sse / http / claudeai-proxy) server menu: the identity card,
// the action menu, and the OAuth surfaces. Unmount safety is load-bearing
// here: an abandoned OAuth flow must abort so the local callback listener
// releases its port, the copy-feedback timer must be cleared, and a clipboard
// write resolving after unmount must touch nothing.

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import Link from '../../ink/components/Link.js'
import useInput from '../../ink/hooks/use-input.js'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  AuthenticationCancelledError,
  performMCPOAuthFlow,
  revokeServerTokens,
} from '../../services/mcp/auth.js'
import { clearMcpAuthCache, getToolDiscoveryFailure } from '../../services/mcp/client.js'
import {
  useMcpReconnect,
  useMcpToggleEnabled,
} from '../../services/mcp/MCPConnectionManager.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import {
  describeMcpConfigFilePath,
  excludeCommandsByServer,
  excludeToolsByServer,
  filterMcpPromptsByServer,
} from '../../services/mcp/utils.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import { openBrowser } from '../../utils/browser.js'
import { copyAnsiToClipboard } from '../../utils/screenshotClipboard.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../CustomSelect/select.js'
import { Spinner } from '../Spinner.js'
import TextInput from '../TextInput.js'
import { CapabilitiesSection } from './CapabilitiesSection.js'
import { describeReconnectOutcome } from './utils/reconnectHelpers.js'
import type {
  ClaudeAIServerInfo,
  HTTPServerInfo,
  SSEServerInfo,
  ServerInfo,
} from './types.js'

const COPY_FEEDBACK_MS = 2_000

type RemoteServerInfo = SSEServerInfo | HTTPServerInfo | ClaudeAIServerInfo

type Phase =
  | { id: 'menu' }
  | { id: 'auth' }
  | { id: 'proxy-auth' }
  | { id: 'proxy-clear-step2' }
  | { id: 'reconnecting' }

function capitalise(name: string): string {
  return name.length > 0 ? name[0]!.toUpperCase() + name.slice(1) : name
}

/** The claude.ai start-auth URL for a proxied server, or the connectors
 *  settings page when the ids are unavailable. The server id replaces a
 *  leading `mcprs` marker with `mcpsrv` (contract data). */
function buildProxyAuthUrl(server: ClaudeAIServerInfo): string {
  const origin = getOauthConfig().CLAUDE_AI_ORIGIN
  const organizationUuid = getOauthAccountInfo()?.organizationUuid
  const serverId = server.config.id?.replace(/^mcprs/, 'mcpsrv')
  if (organizationUuid && serverId) {
    const surface = process.env.MERCURY_ENTRYPOINT ?? 'cli'
    return `${origin}/api/organizations/${organizationUuid}/mcp/start-auth/${serverId}?product_surface=${encodeURIComponent(surface)}`
  }
  return `${origin}/settings/connectors`
}

export function MCPRemoteServerMenu({
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
  const remote = server as RemoteServerInfo
  const isProxy = remote.transport === 'claudeai-proxy'
  const reconnectServer = useMcpReconnect()
  const toggle = useMcpToggleEnabled()
  const setAppState = useSetAppState()
  const commands = useAppState(state => state.mcp.commands)
  const resources = useAppState(state => state.mcp.resources)

  const [phase, setPhase] = useState<Phase>({ id: 'menu' })
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [pasteSubmit, setPasteSubmit] = useState<{
    submit: (pastedUrl: string) => void
  } | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [pasteCursor, setPasteCursor] = useState(0)
  const [copied, setCopied] = useState(false)
  const [resultLine, setResultLine] = useState<string | null>(null)
  const [errorLine, setErrorLine] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountedRef = useRef(false)
  useEffect(
    () => () => {
      // Unmount: abort the flow so the callback listener releases its port,
      // clear the copy timer, and mark unmounted for the pending clipboard
      // write to check.
      unmountedRef.current = true
      abortRef.current?.abort()
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    },
    [],
  )

  const client = remote.client
  const disabled = client.type === 'disabled'
  const connected = client.type === 'connected'
  const effectivelyAuthenticated = remote.isAuthenticated === true
  const toolCount = serverToolsCount

  const reconnectAndReport = async (wasAuthenticated: boolean) => {
    setPhase({ id: 'reconnecting' })
    try {
      const result = await reconnectServer(server.name)
      if (unmountedRef.current) return
      const post: MCPServerConnection = result.client
      if (post.type === 'connected') {
        setResultLine(
          wasAuthenticated
            ? `Reconnected to ${server.name}.`
            : `Connected to ${server.name} for the first time.`,
        )
      } else if (post.type === 'needs-auth') {
        setResultLine(
          `${server.name} still needs authentication — restarting Mercury may help.`,
        )
      } else {
        setResultLine(
          `Reconnecting to ${server.name} failed — restarting Mercury may help.`,
        )
      }
    } catch (error) {
      if (!unmountedRef.current) {
        setErrorLine(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (!unmountedRef.current) setPhase({ id: 'menu' })
    }
  }

  const startOAuth = async () => {
    setErrorLine(null)
    setResultLine(null)
    setAuthUrl(null)
    setPasteSubmit(null)
    setPasteText('')
    setPhase({ id: 'auth' })
    const wasAuthenticated = effectivelyAuthenticated
    const controller = new AbortController()
    abortRef.current = controller
    try {
      if (wasAuthenticated) {
        // Preserve step-up state so scope/discovery info already obtained
        // is not thrown away.
        await revokeServerTokens(server.name, remote.config, {
          preserveStepUpState: true,
        })
      }
      await performMCPOAuthFlow(
        server.name,
        remote.config,
        url => {
          if (!unmountedRef.current) setAuthUrl(url)
        },
        controller.signal,
        {
          onWaitingForCallback: submit => {
            if (!unmountedRef.current) setPasteSubmit({ submit })
          },
        },
      )
      if (unmountedRef.current) return
      await reconnectAndReport(wasAuthenticated)
    } catch (error) {
      if (unmountedRef.current) return
      if (
        error instanceof AuthenticationCancelledError ||
        controller.signal.aborted
      ) {
        // Cancellation shows no error.
      } else if (error instanceof Error) {
        setErrorLine(error.message)
      }
      // A non-Error throw surfaces nothing (accepted).
      setPhase({ id: 'menu' })
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  const clearAuthentication = async () => {
    try {
      await revokeServerTokens(server.name, remote.config)
      clearMcpAuthCache()
      setAppState(previous => ({
        ...previous,
        mcp: {
          ...previous.mcp,
          clients: previous.mcp.clients.map(entry =>
            entry.name === server.name
              ? { type: 'failed', name: entry.name, config: entry.config }
              : entry,
          ),
          tools: excludeToolsByServer(previous.mcp.tools, server.name),
          commands: excludeCommandsByServer(previous.mcp.commands, server.name),
          resources: Object.fromEntries(
            Object.entries(previous.mcp.resources).filter(
              ([name]) => name !== server.name,
            ),
          ),
        },
      }))
      setResultLine(`Authentication for ${server.name} was cleared.`)
    } catch (error) {
      setErrorLine(error instanceof Error ? error.message : String(error))
    }
  }

  const proxyClearStep2 = () => {
    clearMcpAuthCache()
    setAppState(previous => ({
      ...previous,
      mcp: {
        ...previous.mcp,
        clients: previous.mcp.clients.map(entry =>
          entry.name === server.name
            ? { type: 'needs-auth', name: entry.name, config: entry.config }
            : entry,
        ),
        tools: excludeToolsByServer(previous.mcp.tools, server.name),
        commands: excludeCommandsByServer(previous.mcp.commands, server.name),
        resources: Object.fromEntries(
          Object.entries(previous.mcp.resources).filter(
            ([name]) => name !== server.name,
          ),
        ),
      },
    }))
    setResultLine(`${server.name} was disconnected.`)
    setPhase({ id: 'menu' })
  }

  // `c` copies the authorisation URL; the confirmation is transient and the
  // late-resolving write checks the unmounted marker before touching state.
  useInput(
    (input, key) => {
      if (input === 'c' && !key.ctrl && !key.meta && authUrl) {
        void copyAnsiToClipboard(authUrl).then(() => {
          if (unmountedRef.current) return
          setCopied(true)
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
          copyTimerRef.current = setTimeout(() => {
            if (!unmountedRef.current) setCopied(false)
          }, COPY_FEEDBACK_MS)
        })
      }
    },
    { isActive: phase.id === 'auth' },
  )

  // Enter drives the two claude.ai browser walks.
  useInput(
    (_input, key) => {
      if (!key.return) return
      if (phase.id === 'proxy-auth') {
        void reconnectAndReport(effectivelyAuthenticated)
      } else if (phase.id === 'proxy-clear-step2') {
        proxyClearStep2()
      }
    },
    { isActive: phase.id === 'proxy-auth' || phase.id === 'proxy-clear-step2' },
  )

  if (phase.id === 'reconnecting') {
    return (
      <Box>
        <Spinner />
        <Text dimColor>
          {' '}
          Establishing a connection to {server.name} — this can take a moment…
        </Text>
      </Box>
    )
  }

  if (phase.id === 'auth') {
    return (
      <Dialog
        title={capitalise(server.name)}
        onCancel={() => {
          abortRef.current?.abort()
          setPhase({ id: 'menu' })
        }}
      >
        <Box flexDirection="column">
          <Box>
            <Spinner />
            <Text dimColor>
              {' '}
              {authUrl
                ? 'Waiting for the sign-in to finish…'
                : 'Signing in — a cached login can complete without a browser…'}
            </Text>
          </Box>
          {authUrl ? (
            <Box flexDirection="column" marginTop={1}>
              <Text>
                Authorise in your browser:{' '}
                <Link url={authUrl} fallback={authUrl}>
                  {authUrl}
                </Link>
              </Text>
              <Text dimColor>
                {copied ? 'Copied.' : 'Press c to copy the URL.'}
              </Text>
            </Box>
          ) : null}
          {pasteSubmit ? (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>
                If the redirect page shows a connection error, paste the
                address-bar URL from your browser here:
              </Text>
              <TextInput
                value={pasteText}
                onChange={setPasteText}
                cursorOffset={pasteCursor}
                onChangeCursorOffset={setPasteCursor}
                columns={60}
                onSubmit={value => pasteSubmit.submit(value.trim())}
              />
            </Box>
          ) : null}
        </Box>
      </Dialog>
    )
  }

  if (phase.id === 'proxy-auth') {
    return (
      <Dialog
        title={capitalise(server.name)}
        onCancel={() => setPhase({ id: 'menu' })}
      >
        <Text>
          Finish connecting the server in your browser, then press ↵ here.
        </Text>
      </Dialog>
    )
  }

  if (phase.id === 'proxy-clear-step2') {
    return (
      <Dialog
        title={capitalise(server.name)}
        onCancel={() => setPhase({ id: 'menu' })}
      >
        <Text>
          In the connectors page that just opened, find {server.name} and
          disconnect it — then press ↵ here to clear the local state.
        </Text>
      </Dialog>
    )
  }

  const options: Array<{ label: string; value: string }> = []
  if (disabled) options.push({ label: 'Enable', value: 'toggle' })
  if (connected && toolCount > 0) {
    options.push({ label: 'View tools', value: 'tools' })
  }
  if (isProxy) {
    if (connected) {
      options.push({ label: 'Clear authentication', value: 'proxy-clear' })
    } else if (!disabled) {
      options.push({ label: 'Authenticate', value: 'proxy-auth' })
    }
  } else if (effectivelyAuthenticated) {
    options.push({ label: 'Re-authenticate', value: 'oauth' })
    options.push({ label: 'Clear authentication', value: 'clear-auth' })
  } else {
    options.push({ label: 'Authenticate', value: 'oauth' })
  }
  if (!disabled) {
    if (client.type !== 'needs-auth') {
      options.push({ label: 'Reconnect', value: 'reconnect' })
    }
    options.push({ label: 'Disable', value: 'toggle' })
  }
  if (options.length === 0) options.push({ label: 'Back', value: 'back' })

  return (
    <Dialog
      title={capitalise(server.name)}
      onCancel={() => onCancel(isProxy ? 'claude.ai' : 'mercury')}
      hideInputGuide
      hideBorder={borderless}
    >
      <Box flexDirection="column">
        <Text>
          <Text dimColor>Status: </Text>
          {client.type === 'pending' ? 'connecting' : client.type}
        </Text>
        {connected && toolCount === 0 && getToolDiscoveryFailure(server.name) !== null && (
          <Text color="yellow" wrap="truncate-end">
            tool discovery failed — {getToolDiscoveryFailure(server.name)?.message} (retried automatically; Reconnect retries now)
          </Text>
        )}
        {!isProxy ? (
          <Text>
            <Text dimColor>Auth: </Text>
            {remote.isAuthenticated === true
              ? 'authenticated'
              : remote.isAuthenticated === false
                ? 'not authenticated'
                : 'unknown'}
          </Text>
        ) : null}
        <Text>
          <Text dimColor>URL: </Text>
          {remote.config.url}
        </Text>
        <Text>
          <Text dimColor>Config: </Text>
          {describeMcpConfigFilePath(remote.scope)}
        </Text>
        {connected ? (
          <CapabilitiesSection
            toolCount={toolCount}
            resourceCount={(resources[server.name] ?? []).length}
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
            switch (value) {
              case 'tools':
                onViewTools()
                return
              case 'oauth':
                void startOAuth()
                return
              case 'proxy-auth': {
                void openBrowser(buildProxyAuthUrl(remote as ClaudeAIServerInfo))
                setPhase({ id: 'proxy-auth' })
                return
              }
              case 'proxy-clear': {
                void openBrowser(
                  `${getOauthConfig().CLAUDE_AI_ORIGIN}/settings/connectors`,
                )
                setPhase({ id: 'proxy-clear-step2' })
                return
              }
              case 'clear-auth':
                void clearAuthentication()
                return
              case 'reconnect':
                setPhase({ id: 'reconnecting' })
                void reconnectServer(server.name)
                  .then(result => {
                    if (unmountedRef.current) return
                    setResultLine(
                      describeReconnectOutcome(server.name, result.client)
                        .message,
                    )
                  })
                  .catch(error => {
                    if (unmountedRef.current) return
                    setErrorLine(
                      error instanceof Error ? error.message : String(error),
                    )
                  })
                  .finally(() => {
                    if (!unmountedRef.current) setPhase({ id: 'menu' })
                  })
                return
              case 'toggle': {
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
                return
              }
              default:
                onCancel(isProxy ? 'claude.ai' : 'mercury')
            }
          }}
          onCancel={() => onCancel(isProxy ? 'claude.ai' : 'mercury')}
        />
        <Text dimColor>↑↓ navigate · ↵ select · esc back</Text>
      </Box>
    </Dialog>
  )
}
