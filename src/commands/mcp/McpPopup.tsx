import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../services/engine-connector/focusedConnector.js'
import type { McpRosterEntryV1, McpToolEntryV1 } from '../../services/engine-connector/types.js'
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
const MCP_TOOLS_HINT = '↑↓ move · ↵ detail · / filter · esc back to servers'
const MCP_DETAIL_HINT = '↑↓ scroll · esc back to tools'
const MCP_TOOL_LOADING_WORDS: Record<McpToolEntryV1['loading'], string> = {
  deferred: 'deferred · schema loads on demand',
  listed: 'always loaded',
  held: 'held · joins the tool list at the next compaction or /clear',
}

type SchemaNode = {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  properties?: Record<string, SchemaNode | undefined>
  required?: string[]
  items?: SchemaNode
}

type SchemaPropertyLine = {
  key: string
  indent: string
  name: string
  required: boolean
  type: string
  description?: string
}

function collectSchemaProperties(node: SchemaNode | undefined, prefix = '', depth = 0): SchemaPropertyLine[] {
  const properties = Object.entries(node?.properties ?? {})
  const required = new Set(Array.isArray(node?.required) ? node.required : [])
  const out: SchemaPropertyLine[] = []
  for (const [name, prop] of properties) {
    const key = prefix ? `${prefix}.${name}` : name
    const typeLabel = Array.isArray(prop?.type)
      ? prop.type.join(' | ')
      : prop?.type === 'array' && typeof prop.items?.type === 'string'
        ? `${prop.items.type}[]`
        : typeof prop?.type === 'string'
          ? prop.type
          : Array.isArray(prop?.enum)
            ? `enum(${prop.enum.map(String).join(' | ')})`
            : prop?.properties
              ? 'object'
              : 'unknown'
    out.push({
      key,
      indent: '  '.repeat(depth + 1),
      name,
      required: required.has(name),
      type: typeLabel,
      ...(typeof prop?.description === 'string' && prop.description !== '' ? { description: prop.description } : {}),
    })
    if (prop?.properties) out.push(...collectSchemaProperties(prop, key, depth + 1))
    else if (prop?.items?.properties) out.push(...collectSchemaProperties(prop.items, `${key}[]`, depth + 1))
  }
  return out
}

export function mcpServerState(server: McpRosterEntryV1): string {
  if (server.signingIn) return 'signing in… (browser)'
  if (server.type === 'needs-auth') return 'needs sign-in'
  if (server.type === 'disabled') return 'off'
  if (server.type === 'failed') return `failed: ${server.error ?? 'connection failed'}`
  if (server.type === 'pending') return 'connecting…'
  return server.type
}
const MCP_POPUP_CHROME_ROWS = 8
const MCP_POPUP_UNFOLD_ROWS = 6
export function mcpPopupShapeFor(serverCount: number): CommandPopupShape {
  return {
    view: 'mcp',
    width: columns => panelWidth(columns, { cap: WIDTH, min: 24 }),
    rows: rows => Math.min(rows - 4, MCP_POPUP_CHROME_ROWS + Math.max(1, serverCount) + MCP_POPUP_UNFOLD_ROWS),
  }
}

type Row = { key: string; server: McpRosterEntryV1; action?: 'tools' | 'disable' | 'enable' | 'reconnect' }
type ToolViewState = { server: string; tools: readonly McpToolEntryV1[]; tool: McpToolEntryV1 | null }

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
  const [toolView, setToolView] = useState<ToolViewState | null>(null)
  const [toolCursor, setToolCursor] = useState(0)
  const [toolFilter, setToolFilter] = useState('')
  const [toolFilterFocus, setToolFilterFocus] = useState(false)
  const [detailCursor, setDetailCursor] = useState(0)
  const alive = useRef(true)
  const signingIn = useRef<string | null>(null)
  const filterFocusRef = useRef(false)
  const toolFilterFocusRef = useRef(false)
  useEffect(() => () => {
    alive.current = false
    if (signingIn.current) void connector.mcpAction(signingIn.current, 'cancel-auth')
  }, [connector])
  const rows: Row[] = servers.filter(server => server.name.toLowerCase().includes(filter.toLowerCase())).flatMap(server => {
    const rows: Row[] = [{ key: server.name, server }]
    if (expanded === server.name) {
      if (server.type === 'connected') rows.push({ key: `${server.name}:tools`, server, action: 'tools' })
      if (!isMcpOrgan(server.name)) rows.push({ key: `${server.name}:toggle`, server, action: server.type === 'disabled' ? 'enable' : 'disable' })
      rows.push({ key: `${server.name}:reconnect`, server, action: 'reconnect' })
    }
    return rows
  })
  const at = Math.min(cursor, Math.max(0, rows.length - 1))
  const win = paneWindow(rows.length, at, Math.max(1, height - MCP_POPUP_CHROME_ROWS))
  const filteredTools = toolView
    ? toolView.tools.filter(tool => tool.name.toLowerCase().includes(toolFilter.toLowerCase()) || tool.description.toLowerCase().includes(toolFilter.toLowerCase()))
    : []
  const toolAt = Math.min(toolCursor, Math.max(0, filteredTools.length - 1))
  const toolWin = paneWindow(filteredTools.length, toolAt, Math.max(1, height - MCP_POPUP_CHROME_ROWS))
  const schemaProps = toolView?.tool ? collectSchemaProperties(toolView.tool.inputSchema as SchemaNode) : []
  const descText = toolView?.tool ? (toolView.tool.description || 'No description.') : ''
  const descLines = Math.max(1, Math.ceil(descText.length / Math.max(1, inner)))
  const detailAt = Math.min(detailCursor, Math.max(0, schemaProps.length - 1))
  const detailWin = paneWindow(schemaProps.length, detailAt, Math.max(1, height - 6 - descLines - (schemaProps.length > 0 ? 1 : 0)))
  const run = async (row: Row): Promise<void> => {
    if (busy !== null) return
    const { server, action } = row
    if (!action && (server.type === 'connected' || server.type === 'disabled')) {
      setExpanded(current => current === server.name ? null : server.name)
      return
    }
    if (action === 'tools') {
      setMessage('')
      setBusy(server.name)
      try {
        const result = await connector.mcpTools(server.name)
        if (alive.current && result.state !== 'connected') setMessage(result.detail ?? mcpServerState(server))
        else if (alive.current) {
          toolFilterFocusRef.current = false
          setToolView({ server: server.name, tools: result.tools, tool: null })
          setToolCursor(0)
          setToolFilter('')
          setToolFilterFocus(false)
        }
      } catch (error) {
        if (alive.current) setMessage(error instanceof Error ? error.message : String(error))
      } finally {
        if (alive.current) setBusy(null)
      }
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
    if (toolView?.tool) {
      if (key.escape) { setToolView({ ...toolView, tool: null }); return }
      if (key.upArrow || key.downArrow) { setDetailCursor(Math.max(0, Math.min(schemaProps.length - 1, detailAt + (key.downArrow ? 1 : -1)))); return }
      return
    }
    if (toolView) {
      if (key.escape) { toolFilterFocusRef.current = false; setToolView(null); setToolFilter(''); setToolFilterFocus(false); setToolCursor(0); return }
      if (key.upArrow || key.downArrow) { setToolCursor(Math.max(0, Math.min(filteredTools.length - 1, toolAt + (key.downArrow ? 1 : -1)))); return }
      if (key.return) { if (pastOpenEvent() && filteredTools[toolAt]) { setDetailCursor(0); setToolView({ ...toolView, tool: filteredTools[toolAt]! }) }; return }
      if (toolFilterFocus || toolFilterFocusRef.current) {
        if (key.backspace || key.delete) setToolFilter(current => current.slice(0, -1))
        else if (input && !key.ctrl && !key.meta && !key.tab && pastOpenEvent()) setToolFilter(current => current + input)
        setToolCursor(0)
        return
      }
      if (input.startsWith('/') && pastOpenEvent()) {
        toolFilterFocusRef.current = true
        setToolFilterFocus(true)
        if (input.length > 1) {
          setToolFilter(current => current + input.slice(1))
          setToolCursor(0)
        }
        return
      }
      const nav = decodeNavKey(input, key, { orientation: 'vertical' })
      if (nav === 'first') setToolCursor(0)
      if (nav === 'last') setToolCursor(Math.max(0, filteredTools.length - 1))
      return
    }
    if (key.escape) { onDone(); return }
    if (key.upArrow || key.downArrow) { setCursor(Math.max(0, Math.min(rows.length - 1, at + (key.downArrow ? 1 : -1)))); return }
    if (key.return) { if (pastOpenEvent() && rows[at]) void run(rows[at]); return }
    if (filterFocus || filterFocusRef.current) {
      if (key.backspace || key.delete) setFilter(current => current.slice(0, -1))
      else if (input && !key.ctrl && !key.meta && !key.tab && pastOpenEvent()) setFilter(current => current + input)
      setCursor(0)
      return
    }
    if (input.startsWith('/') && pastOpenEvent()) {
      filterFocusRef.current = true
      setFilterFocus(true)
      if (input.length > 1) {
        setFilter(current => current + input.slice(1))
        setCursor(0)
      }
      return
    }
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
  if (toolView?.tool) {
    const activeTool = toolView.tool
    return (
      <Box ref={surface} flexDirection="column" width={width} height={height} borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} opaque flexShrink={0} {...(ground !== undefined ? { backgroundColor: ground } : {})}>
        <ProductLockup view="mcp" subtitle={`${toolView.server} · ${activeTool.name}`} separator=" · " />
        <Text color={tokens.textMuted} wrap="truncate-end">{activeTool.registeredAs} · {MCP_TOOL_LOADING_WORDS[activeTool.loading]}</Text>
        <Box height={1} />
        <Text color={tokens.textPrimary} wrap="wrap">{descText}</Text>
        {schemaProps.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={tokens.textMuted}>Parameters</Text>
            {schemaProps.slice(detailWin.start, detailWin.end).map(prop => (
              <Text key={prop.key} wrap="truncate-end">
                {prop.indent}
                <Text bold color={tokens.textPrimary}>{prop.name}</Text>
                {prop.required ? <Text color={tokens.warning}>*</Text> : null}
                <Text color={tokens.textMuted}> {prop.type}</Text>
                {prop.description ? <Text color={tokens.textMuted}> — {prop.description}</Text> : null}
              </Text>
            ))}
          </Box>
        ) : null}
        <Box flexGrow={1} />
        <Text color={tokens.textMuted}>{cutToWidth(MCP_DETAIL_HINT, inner)}</Text>
      </Box>
    )
  }
  if (toolView) {
    const selectedTool = filteredTools[toolAt]
    return (
      <Box ref={surface} flexDirection="column" width={width} height={height} borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} opaque flexShrink={0} {...(ground !== undefined ? { backgroundColor: ground } : {})}>
        <ProductLockup view="mcp" subtitle={toolView.server} separator=" · " />
        <Text color={tokens.textMuted}>{toolView.tools.length} {toolView.tools.length === 1 ? 'tool' : 'tools'} · this session</Text>
        <Box height={1} />
        {filteredTools.length === 0 ? <Text color={tokens.textMuted}>{toolFilter ? 'No matching tools' : 'This server exposes no tools.'}</Text> : filteredTools.slice(toolWin.start, toolWin.end).map((tool, index) => {
          const selected = toolWin.start + index === toolAt
          const oneLine = tool.description.replace(/\s+/g, ' ').trim()
          const label = oneLine ? `${tool.name} · ${oneLine}` : tool.name
          return <InteractiveRow key={tool.name} id={`mcp:tool:${toolView.server}:${tool.name}`} selected={selected} onSelect={() => setToolCursor(toolWin.start + index)} onActivate={() => { setDetailCursor(0); setToolView({ ...toolView, tool }) }} width={inner} height={1}><Text color={selected ? accent : tokens.textPrimary} wrap="truncate-end">{selected ? '› ' : '  '}{cutToWidth(label, Math.max(1, inner - 2))}</Text></InteractiveRow>
        })}
        <Box flexGrow={1} />
        <Box minHeight={1} width={inner}><Text color={tokens.textMuted}>{selectedTool ? MCP_TOOL_LOADING_WORDS[selectedTool.loading] : ''}</Text></Box>
        <MenuFilterLine focused={toolFilterFocus} text={toolFilter} placeholder="filter tools" accent={accent} muted={tokens.textMuted} primary={tokens.textPrimary} />
        <Text color={tokens.textMuted}>{cutToWidth(MCP_TOOLS_HINT, inner)}</Text>
      </Box>
    )
  }
  return (
    <Box ref={surface} flexDirection="column" width={width} height={height} borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} opaque flexShrink={0} {...(ground !== undefined ? { backgroundColor: ground } : {})}>
      <ProductLockup view="mcp" separator=" · " />
      <Text color={tokens.textMuted}>{servers.length} servers · this session</Text>
      <Box height={1} />
      {rows.length === 0 ? <Text color={tokens.textMuted}>{filter ? 'No matching servers' : 'No MCP servers · mercury mcp add to add one'}</Text> : rows.slice(win.start, win.end).map((row, index) => {
        const selected = win.start + index === at
        const label = row.action
          ? `  ${row.action === 'disable' ? 'disable for this session' : row.action === 'enable' ? 'enable for this session' : row.action === 'tools' ? 'tools' : 'reconnect'}`
          : `${row.server.name} · ${stateOf(row.server)}${row.server.addedAt && Date.now() - row.server.addedAt < 60_000 ? ' · added just now' : ''}${expanded === row.server.name && row.server.type === 'connected' ? ` · ${row.server.toolCount ?? 0} tools` : ''}`
        return <InteractiveRow key={row.key} id={`mcp:${row.key}`} selected={selected} onSelect={() => setCursor(win.start + index)} onActivate={() => { void run(row) }} width={inner} height={1}><Text color={selected ? accent : tokens.textPrimary} wrap="truncate-end">{selected ? '› ' : '  '}{cutToWidth(label, Math.max(1, inner - 2))}</Text></InteractiveRow>
      })}
      <Box flexGrow={1} />
      <Box minHeight={1} width={inner}><Text color={tokens.warning}>{detail}</Text></Box>
      <MenuFilterLine focused={filterFocus} text={filter} placeholder="filter by name" accent={accent} muted={tokens.textMuted} primary={tokens.textPrimary} />
      <Text color={tokens.textMuted}>{cutToWidth(MCP_POPUP_HINT, inner)}</Text>
    </Box>
  )
}
