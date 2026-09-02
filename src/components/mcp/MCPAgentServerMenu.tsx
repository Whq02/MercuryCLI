// The agent-declared server menu. These servers connect only when their
// owning agent runs, so the status is fixed; authentication (HTTP/SSE only)
// runs the OAuth flow against a temporary config and reports that the
// connection itself is deferred.

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import Link from '../../ink/components/Link.js'
import {
  AuthenticationCancelledError,
  MercuryMcpAuthProvider,
  performMCPOAuthFlow,
} from '../../services/mcp/auth.js'
import type { McpServerConfig } from '../../services/mcp/types.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../CustomSelect/select.js'
import { Spinner } from '../Spinner.js'
import type { AgentMcpServerInfo } from './types.js'

function temporaryConfig(server: AgentMcpServerInfo): McpServerConfig | null {
  if (server.transport === 'sse' && server.url) {
    return { type: 'sse', url: server.url } as McpServerConfig
  }
  if (server.transport === 'http' && server.url) {
    return { type: 'http', url: server.url } as McpServerConfig
  }
  return null
}

export function MCPAgentServerMenu({
  agentServer,
  onBack,
}: {
  agentServer: AgentMcpServerInfo
  onBack: () => void
}): React.ReactNode {
  const canAuthenticate =
    agentServer.transport === 'sse' || agentServer.transport === 'http'

  const [authenticating, setAuthenticating] = useState(false)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [resultLine, setResultLine] = useState<string | null>(null)
  const [errorLine, setErrorLine] = useState<string | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(
    agentServer.isAuthenticated,
  )

  const abortRef = useRef<AbortController | null>(null)
  const unmountedRef = useRef(false)
  useEffect(
    () => () => {
      unmountedRef.current = true
      abortRef.current?.abort()
    },
    [],
  )

  // Lazily learn the current auth state from stored tokens.
  useEffect(() => {
    if (!canAuthenticate || isAuthenticated !== undefined) return
    const config = temporaryConfig(agentServer)
    if (!config) return
    let live = true
    void new MercuryMcpAuthProvider(agentServer.name, config)
      .tokens()
      .then(tokens => {
        if (live) setIsAuthenticated(tokens !== undefined)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [agentServer, canAuthenticate, isAuthenticated])

  const startAuth = async () => {
    const config = temporaryConfig(agentServer)
    if (!config) return
    setErrorLine(null)
    setResultLine(null)
    setAuthUrl(null)
    setAuthenticating(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await performMCPOAuthFlow(
        agentServer.name,
        config,
        url => {
          if (!unmountedRef.current) setAuthUrl(url)
        },
        controller.signal,
      )
      if (unmountedRef.current) return
      setIsAuthenticated(true)
      setResultLine(
        `Authenticated. ${agentServer.name} connects when its agent next runs.`,
      )
    } catch (error) {
      if (unmountedRef.current) return
      if (
        error instanceof AuthenticationCancelledError ||
        controller.signal.aborted
      ) {
        // Cancelled: no error.
      } else if (error instanceof Error) {
        setErrorLine(error.message)
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      if (!unmountedRef.current) {
        setAuthenticating(false)
        setAuthUrl(null)
      }
    }
  }

  if (authenticating) {
    return (
      <Dialog
        title={agentServer.name}
        onCancel={() => {
          abortRef.current?.abort()
          setAuthenticating(false)
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
            <Text>
              Authorise in your browser:{' '}
              <Link url={authUrl} fallback={authUrl}>
                {authUrl}
              </Link>
            </Text>
          ) : null}
        </Box>
      </Dialog>
    )
  }

  const options: Array<{ label: string; value: string }> = []
  if (canAuthenticate) {
    options.push({
      label: isAuthenticated === true ? 'Re-authenticate' : 'Authenticate',
      value: 'auth',
    })
  }
  options.push({ label: 'Back', value: 'back' })

  return (
    <Dialog title={agentServer.name} onCancel={onBack} hideInputGuide>
      <Box flexDirection="column">
        <Text>
          <Text dimColor>Transport: </Text>
          {agentServer.transport}
        </Text>
        {agentServer.url ? (
          <Text>
            <Text dimColor>URL: </Text>
            {agentServer.url}
          </Text>
        ) : null}
        {agentServer.command ? (
          <Text>
            <Text dimColor>Command: </Text>
            {agentServer.command}
          </Text>
        ) : null}
        <Text>
          <Text dimColor>Used by: </Text>
          {agentServer.sourceAgents.join(', ')}
        </Text>
        <Text>
          <Text dimColor>Status: </Text>
          not connected (agent-only — connects when its agent runs)
        </Text>
        {canAuthenticate ? (
          <Text>
            <Text dimColor>Auth: </Text>
            {isAuthenticated === true
              ? 'authenticated'
              : 'may need authentication'}
          </Text>
        ) : null}
        {resultLine ? <Text dimColor>{resultLine}</Text> : null}
        {errorLine ? <Text color="error">{errorLine}</Text> : null}
        <Select
          options={options}
          onChange={value => {
            if (value === 'auth') void startAuth()
            else onBack()
          }}
          onCancel={onBack}
        />
        <Text dimColor>↑↓ navigate · ↵ select · esc back</Text>
      </Box>
    </Dialog>
  )
}
