import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../services/engine-connector/focusedConnector.js'
import type { McpRosterEntryV1 } from '../../services/engine-connector/types.js'
import { isMcpOrgan } from '../../services/mcp/membership.js'
import { mcpRosterRowsFailedFirst } from './route.js'
import { InteractiveRow } from '../../components/mercury-ui/InteractiveRow.js'
import { ProductLockup } from '../../components/mercury-ui/components.js'
import { paneWindow, panelWidth } from '../../components/mercury-ui/geometry.js'
import { MenuFilterLine, cutToWidth } from '../../components/mercury-ui/menuFold.js'
import { decodeNavKey } from '../../components/mercury-ui/navSemantics.js'
import { useElevatedSurface } from '../../components/mercury-ui/useElevatedSurface.js'
import { useOpenEventGate } from '../../components/mercury-ui/useOpenEventGate.js'
import { useSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { PopupFrameContext } from '../../components/PopupGutter.js'
import { estateGroundBg } from '../../utils/mercuryTokens.js'
import type { CommandPopupShape } from '../../utils/cockpit/commandPopup.js'

const subscribe = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const WIDTH = 78
const MCP_POPUP_HINT = '↑↓ move · ↵ act · / filter · esc or click outside closes'

export function mcpServerState(server: McpRosterEntryV1): string {
  if (server.signingIn) return 'signing in… (browser)'
  if (server.type === 'needs-auth') return 'needs sign-in'
  if (server.type === 'disabled') return 'off'
  if (server.type === 'failed') return `failed: ${server.error ?? 'connection failed'}`
  if (server.type === 'pending') return 'connecting…'
  return server.type
}
export const mcpPopupShape: CommandPopupShape = {
  view: 'mcp',
  width: columns => panelWidth(columns, { cap: WIDTH, min: 24 }),
  rows: rows => Math.min(22, rows - 4),
}

type Row = { key: string; server: McpRosterEntryV1; action?: 'disable' | 'enable' | 'reconnect' }

export function McpPopup({ onDone }: { onDone: (message?: string) => void }): React.ReactNode {
  const [, repaint] = useState(0)
  useEffect(() => subscribe(() => repaint(value => value + 1)), [])
  const connector = getFocusedSessionConnector()
  const servers = mcpRosterRowsFailedFirst(connector.mcpRoster())
  const tokens = useMercuryTokens()
  const { accent } = useSessionAccent()
  const surface = useElevatedSurface()
  const terminal = useTerminalSize()
  const slot = useModalOrTerminalSize(terminal)
  const frame = React.useContext(PopupFrameContext)
  const width = Math.min(frame?.width ?? slot.columns, WIDTH)
  const inner = Math.max(1, width - 4)
  const height = frame?.rows ?? slot.rows
  const token = useRegisterOverlay('mcp-popup')
  const pastOpenEvent = useOpenEventGate()
  const [cursor, setCursor] = useState(0)
  const [filter, setFilter] = useState('')
  const [filterFocus, setFilterFocus] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const alive = useRef(true)
  const signingIn = useRef<string | null>(null)
  useEffect(() => () => {
    alive.current = false
    if (signingIn.current) void connector.mcpAction(signingIn.current, 'cancel-auth')
  }, [connector])
  const rows: Row[] = servers.filter(server => server.name.toLowerCase().includes(filter.toLowerCase())).flatMap(server => {
    const rows: Row[] = [{ key: server.name, server }]
    if (expanded === server.name) {
      if (!isMcpOrgan(server.name)) rows.push({ key: `${server.name}:toggle`, server, action: server.type === 'disabled' ? 'enable' : 'disable' })
      rows.push({ key: `${server.name}:reconnect`, server, action: 'reconnect' })
    }
    return rows
  })
  const at = Math.min(cursor, Math.max(0, rows.length - 1))
  const win = paneWindow(rows.length, at, Math.max(1, height - 7))
  const run = async (row: Row): Promise<void> => {
    if (busy !== null) return
    const { server, action } = row
    if (!action && (server.type === 'connected' || server.type === 'disabled')) {
      setExpanded(current => current === server.name ? null : server.name)
      return
    }
    setMessage('')
    setBusy(server.name)
    const auth = !action && server.type === 'needs-auth'
    if (auth) signingIn.current = server.name
    try {
      const result = action === 'disable' || action === 'enable'
        ? await connector.setKit({ mcp: [{ name: server.name, on: action === 'enable' }] })
        : await connector.mcpAction(server.name, auth ? 'authenticate' : 'reconnect')
      if (alive.current && result.outcome !== 'applied') setMessage(result.detail ?? result.outcome)
    } catch (error) {
      if (alive.current) setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      signingIn.current = null
      if (alive.current) setBusy(null)
    }
  }
  useInput((input, key, event) => {
    if (token !== null && !isTopOverlayNow(token)) return
    event.stopImmediatePropagation()
    if (key.escape) { onDone(); return }
    if (key.upArrow || key.downArrow) { setCursor(Math.max(0, Math.min(rows.length - 1, at + (key.downArrow ? 1 : -1)))); return }
    if (key.return) { if (pastOpenEvent() && rows[at]) void run(rows[at]); return }
    if (filterFocus) {
      if (key.backspace || key.delete) setFilter(current => current.slice(0, -1))
      else if (input && !key.ctrl && !key.meta && !key.tab && pastOpenEvent()) setFilter(current => current + input)
      setCursor(0)
      return
    }
    if (input === '/' && pastOpenEvent()) { setFilterFocus(true); return }
    const action = decodeNavKey(input, key, { orientation: 'vertical' })
    if (action === 'first') setCursor(0)
    if (action === 'last') setCursor(Math.max(0, rows.length - 1))
  })
  const stateOf = (server: McpRosterEntryV1): string => {
    if (server.signingIn || signingIn.current === server.name) return 'signing in… (browser)'
    if (busy === server.name) return 'connecting…'
    return mcpServerState(server)
  }
  const detail = message || (rows[at]?.server.type === 'failed' ? rows[at]?.server.error ?? 'connection failed' : '')
  const ground = estateGroundBg(tokens)
  return (
    <Box ref={surface} flexDirection="column" width={width} height={height} borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} opaque flexShrink={0} {...(ground !== undefined ? { backgroundColor: ground } : {})}>
      <ProductLockup view="mcp" separator=" · " />
      <Text color={tokens.textMuted}>{servers.length} servers · this session</Text>
      <Box height={1} />
      {rows.length === 0 ? <Text color={tokens.textMuted}>{filter ? 'No matching servers' : 'No MCP servers · mercury mcp add to add one'}</Text> : rows.slice(win.start, win.end).map((row, index) => {
        const selected = win.start + index === at
        const label = row.action
          ? `  ${row.action === 'disable' ? 'disable for this session' : row.action === 'enable' ? 'enable for this session' : 'reconnect'}`
          : `${row.server.name} · ${stateOf(row.server)}${row.server.addedAt && Date.now() - row.server.addedAt < 60_000 ? ' · added just now' : ''}${expanded === row.server.name && row.server.type === 'connected' ? ` · ${row.server.toolCount ?? 0} tools` : ''}`
        return <InteractiveRow key={row.key} id={`mcp:${row.key}`} selected={selected} onSelect={() => setCursor(win.start + index)} onActivate={() => { void run(row) }} width={inner} height={1}><Text color={selected ? accent : tokens.textPrimary} wrap="truncate-end">{selected ? '› ' : '  '}{cutToWidth(label, Math.max(1, inner - 2))}</Text></InteractiveRow>
      })}
      <Box minHeight={1} width={inner}><Text color={tokens.warning}>{detail}</Text></Box>
      <MenuFilterLine focused={filterFocus} text={filter} placeholder="filter by name" accent={accent} muted={tokens.textMuted} primary={tokens.textPrimary} />
      <Text color={tokens.textMuted}>{cutToWidth(MCP_POPUP_HINT, inner)}</Text>
    </Box>
  )
}
