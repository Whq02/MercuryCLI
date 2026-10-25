import * as React from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../services/engine-connector/focusedConnector.js'
import type { McpRosterEntryV1, McpToolEntryV1 } from '../../services/engine-connector/types.js'
import { isMcpOrgan } from '../../services/mcp/membership.js'
import { MCP_TOOLS_ANSWER_BYTES, MCP_TOOL_DESCRIPTION_CHARS } from '../../services/mcp/toolsAnswer.js'
import { mcpRosterRowsFailedFirst } from './route.js'
import { InteractiveRow } from '../../components/mercury-ui/InteractiveRow.js'
import { ProductLockup } from '../../components/mercury-ui/components.js'
import { panelWidth, scrolledWindow } from '../../components/mercury-ui/geometry.js'
import { PopupListViewport, popupListWindow as paneWindow, usePopupListPaging } from '../../components/CustomSelect/popup-list.js'
import { MenuFilterLine, cutToWidth } from '../../components/mercury-ui/menuFold.js'
import { decodeNavKey } from '../../components/mercury-ui/navSemantics.js'
import { useElevatedSurface } from '../../components/mercury-ui/useElevatedSurface.js'
import { useOpenEventGate } from '../../components/mercury-ui/useOpenEventGate.js'
import { useSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { PopupFrameContext } from '../../components/PopupGutter.js'
import { estateGroundBg } from '../../utils/mercuryTokens.js'
import { commandPopupClaim, growCommandPopup, type CommandPopupShape } from '../../utils/cockpit/commandPopup.js'
import { wrapPlain } from '../../utils/cockpit/helmConsoleText.js'
import { stripTerminalControls } from '../../utils/stringUtils.js'

const subscribe = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const WIDTH = 78
const MCP_POPUP_HINT = '↑↓ move · ↵ act · / filter · esc or click outside closes'
const MCP_TOOLS_HINT = '↑↓ move · ↵ detail · / filter · esc back to servers'
const MCP_DETAIL_HINT = '↑↓ scroll · pgup/pgdn page · esc back to tools'
const MCP_TOOL_LOADING_WORDS: Record<McpToolEntryV1['loading'], string> = {
  deferred: 'deferred · schema loads on demand',
  listed: 'always loaded',
  held: 'held · joins the tool list at the next compaction or /clear',
}
const SCHEMA_DEPTH_SHOWN = 8

const inert = (text: string): string => stripTerminalControls(text)
const inertLine = (text: string): string => stripTerminalControls(text).replace(/\s+/g, ' ').trim()
const kilobytes = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en-US')} KB`

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
  const fields = node?.properties
  const properties = typeof fields === 'object' && fields !== null && !Array.isArray(fields) ? Object.entries(fields) : []
  const required = new Set(Array.isArray(node?.required) ? node.required.filter(name => typeof name === 'string') : [])
  const out: SchemaPropertyLine[] = []
  for (const [name, entry] of properties) {
    const prop = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry : undefined
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
    const nested = prop?.properties ? prop : prop?.items?.properties ? prop.items : undefined
    if (nested !== undefined && depth + 1 >= SCHEMA_DEPTH_SHOWN) out.push({ key: `${key}:deeper`, indent: '  '.repeat(depth + 2), name: '…', required: false, type: 'deeper fields not shown' })
    else if (nested !== undefined) out.push(...collectSchemaProperties(nested, nested === prop ? key : `${key}[]`, depth + 1))
  }
  return out
}

type DetailSegment = { text: string; tone: 'primary' | 'muted' | 'warning'; bold?: true }
type DetailLine = { key: string; segments: DetailSegment[] }

function mcpToolDetailLines(tool: McpToolEntryV1, width: number): DetailLine[] {
  const prose = (key: string, text: string, tone: DetailSegment['tone']): DetailLine[] =>
    wrapPlain(text, width).map((line, index) => ({ key: `${key}:${index}`, segments: [{ text: line === '' ? ' ' : line, tone }] }))
  const lines = prose('description', inert(tool.description).trim() || 'No description.', 'primary')
  if (tool.descriptionCut === true) lines.push(...prose('cut', `(the description is cut at ${MCP_TOOL_DESCRIPTION_CHARS.toLocaleString('en-US')} characters)`, 'muted'))
  if (tool.schemaWithheldBytes !== undefined) {
    lines.push({ key: 'gap', segments: [{ text: ' ', tone: 'muted' }] })
    lines.push(...prose('withheld', `The input schema (${kilobytes(tool.schemaWithheldBytes)}) did not fit this view's ${kilobytes(MCP_TOOLS_ANSWER_BYTES)} read of the server, so its parameters are not listed here.`, 'warning'))
    return lines
  }
  const props = collectSchemaProperties(tool.inputSchema as SchemaNode)
  if (props.length === 0) return lines
  lines.push({ key: 'gap', segments: [{ text: ' ', tone: 'muted' }] })
  lines.push({ key: 'parameters', segments: [{ text: 'Parameters', tone: 'muted' }] })
  for (const prop of props) {
    lines.push({
      key: `field:${prop.key}`,
      segments: [
        { text: prop.indent, tone: 'muted' },
        { text: inertLine(prop.name), tone: 'primary', bold: true },
        ...(prop.required ? [{ text: '*', tone: 'warning' as const }] : []),
        { text: ` ${inertLine(prop.type)}`, tone: 'muted' },
        ...(prop.description ? [{ text: ` — ${inertLine(prop.description)}`, tone: 'muted' as const }] : []),
      ],
    })
  }
  return lines
}

function mcpToolsFailureWords(server: string, detail: string): string {
  if (/older|too old/i.test(detail)) return 'This Mercury background process is too old to list tools. Update Mercury. Run /restart, then open /mcp again.'
  if (/not connected/i.test(detail)) return `The MCP server '${inertLine(server)}' is not connected. Reconnect it from the servers list, then open tools again.`
  if (/no chat is open/i.test(detail)) return 'No chat is open. Choose New Session from the boot menu, then open /mcp.'
  const text = inert(detail).trim()
  return text ? text[0]!.toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.') : 'The tool list is unavailable. Return to the servers list and reconnect.'
}

export function mcpServerState(server: McpRosterEntryV1): string {
  if (server.signingIn) return 'signing in… (browser)'
  if (server.type === 'needs-auth') return 'needs sign-in'
  if (server.type === 'disabled') return 'off'
  if (server.type === 'failed') return `failed: ${server.error ?? 'connection failed'}`
  if (server.type === 'pending') return 'connecting…'
  return server.type
}
const MCP_POPUP_CHROME_ROWS = 9
const MCP_POPUP_UNFOLD_ROWS = 3
const MCP_DETAIL_CHROME_ROWS = 6
export function mcpPopupShapeFor(serverCount: number): CommandPopupShape {
  return {
    view: 'mcp',
    width: columns => panelWidth(columns, { cap: WIDTH, min: 24 }),
    rows: rows => Math.min(rows - 4, MCP_POPUP_CHROME_ROWS + Math.max(1, serverCount) + MCP_POPUP_UNFOLD_ROWS),
  }
}

type Row = { key: string; server: McpRosterEntryV1; action?: 'tools' | 'disable' | 'enable' | 'reconnect' }
type ToolViewState = { server: string; tools: readonly McpToolEntryV1[]; omitted: number; reason: string | null; tool: McpToolEntryV1 | null }

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
  const [listing, setListing] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [toolView, setToolView] = useState<ToolViewState | null>(null)
  const popupToken = useRef(commandPopupClaim()?.token)
  const browsingTools = toolView !== null
  useLayoutEffect(() => {
    if (browsingTools && popupToken.current !== undefined) growCommandPopup(popupToken.current, 26)
  }, [browsingTools])
  const [toolCursor, setToolCursor] = useState(0)
  const [toolFilter, setToolFilter] = useState('')
  const [toolFilterFocus, setToolFilterFocus] = useState(false)
  const [detailScroll, setDetailScroll] = useState(0)
  const alive = useMemo(() => ({ current: true }), [connector])
  const signingIn = useMemo(() => ({ current: null as string | null }), [connector])
  const filterFocusRef = useRef(false)
  const toolFilterFocusRef = useRef(false)
  useEffect(() => {
    alive.current = true
    setBusy(null)
    setListing(null)
    setToolView(null)
    return () => {
      alive.current = false
      if (signingIn.current) void connector.mcpAction(signingIn.current, 'cancel-auth')
    }
  }, [connector, alive, signingIn])
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
  const needle = toolFilter.toLowerCase()
  const filteredTools = toolView
    ? toolView.tools.filter(tool => inertLine(tool.name).toLowerCase().includes(needle) || inertLine(tool.description).toLowerCase().includes(needle))
    : []
  const toolAt = Math.min(toolCursor, Math.max(0, filteredTools.length - 1))
  const toolWin = paneWindow(filteredTools.length, toolAt, Math.max(1, height - MCP_POPUP_CHROME_ROWS))
  const reasonLines = useMemo(() => (toolView?.reason ? wrapPlain(inert(toolView.reason), inner) : []), [toolView?.reason, inner])
  const reasonRows = Math.max(1, height - MCP_POPUP_CHROME_ROWS)
  const reasonSpan = reasonLines.length > reasonRows ? Math.max(1, reasonRows - 1) : reasonRows
  const reasonWin = scrolledWindow(reasonLines.length, detailScroll, reasonSpan)
  const activeTool = toolView?.tool ?? null
  const detailLines = useMemo(() => (activeTool ? mcpToolDetailLines(activeTool, inner) : []), [activeTool, inner])
  const bodyRows = Math.max(1, height - MCP_DETAIL_CHROME_ROWS)
  const detailSpan = detailLines.length > bodyRows ? Math.max(1, bodyRows - 1) : bodyRows
  const detailWin = scrolledWindow(detailLines.length, detailScroll, detailSpan)
  const scrollDetail = (to: number): void => setDetailScroll(Math.max(0, Math.min(Math.max(0, detailLines.length - detailSpan), to)))
  usePopupListPaging(at, rows.length, height - MCP_POPUP_CHROME_ROWS, setCursor, toolView === null)
  usePopupListPaging(toolAt, filteredTools.length, height - MCP_POPUP_CHROME_ROWS, setToolCursor, toolView !== null && toolView.tool === null && toolView.reason === null)
  usePopupListPaging(reasonWin.start, Math.max(0, reasonLines.length - reasonSpan) + 1, reasonSpan, setDetailScroll, toolView !== null && toolView.tool === null && toolView.reason !== null)
  const openTool = (view: ToolViewState, tool: McpToolEntryV1): void => {
    setDetailScroll(0)
    setToolView({ ...view, tool })
  }
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
      setListing(server.name)
      try {
        const result = await connector.mcpTools(server.name)
        if (alive.current) {
          const reason = result.state === 'connected' ? null : mcpToolsFailureWords(server.name, result.detail ?? `The server is ${result.state}`)
          toolFilterFocusRef.current = false
          setToolView({ server: server.name, tools: reason === null ? result.tools : [], omitted: reason === null ? result.omitted : 0, reason, tool: null })
          setDetailScroll(0)
          setToolCursor(0)
          setToolFilter('')
          setToolFilterFocus(false)
        }
      } catch (error) {
        if (alive.current) setMessage(error instanceof Error ? error.message : String(error))
      } finally {
        if (alive.current) {
          setBusy(null)
          setListing(null)
        }
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
      const nav = decodeNavKey(input, key, { orientation: 'vertical', pageKeys: true })
      if (nav === 'movePrevious' || nav === 'moveNext') scrollDetail(detailWin.start + (nav === 'moveNext' ? 1 : -1))
      else if (nav === 'pagePrevious' || nav === 'pageNext') scrollDetail(detailWin.start + (nav === 'pageNext' ? detailSpan : -detailSpan))
      else if (nav === 'first') scrollDetail(0)
      else if (nav === 'last') scrollDetail(detailLines.length)
      return
    }
    if (toolView) {
      if (key.escape) { toolFilterFocusRef.current = false; setToolView(null); setToolFilter(''); setToolFilterFocus(false); setToolCursor(0); return }
      if (toolView.reason !== null) {
        const nav = decodeNavKey(input, key, { orientation: 'vertical' })
        if (nav === 'movePrevious' || nav === 'moveNext') setDetailScroll(Math.max(0, Math.min(Math.max(0, reasonLines.length - reasonSpan), reasonWin.start + (nav === 'moveNext' ? 1 : -1))))
        return
      }
      if (key.upArrow || key.downArrow) { setToolCursor(Math.max(0, Math.min(filteredTools.length - 1, toolAt + (key.downArrow ? 1 : -1)))); return }
      if (key.return) { if (pastOpenEvent() && filteredTools[toolAt]) openTool(toolView, filteredTools[toolAt]!); return }
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
    if (listing === server.name) return 'listing tools…'
    if (busy === server.name) return 'connecting…'
    return mcpServerState(server)
  }
  const detail = message || (rows[at]?.server.type === 'failed' ? rows[at]?.server.error ?? 'connection failed' : '')
  const ground = estateGroundBg(tokens)
  if (toolView?.tool) {
    const shownTool = toolView.tool
    return (
      <Box ref={surface} flexDirection="column" width={width} height={height} borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} opaque flexShrink={0} {...(ground !== undefined ? { backgroundColor: ground } : {})}>
        <ProductLockup view="mcp" subtitle={`${inertLine(toolView.server)} · ${inertLine(shownTool.name)}`} separator=" · " />
        <Text color={tokens.textMuted} wrap="truncate-end">{inertLine(shownTool.registeredAs)} · {MCP_TOOL_LOADING_WORDS[shownTool.loading]}</Text>
        <Box height={1} />
        {detailLines.slice(detailWin.start, detailWin.end).map(line => (
          <Text key={line.key} wrap="truncate-end">
            {line.segments.map((segment, index) => <Text key={index} bold={segment.bold === true} color={segment.tone === 'warning' ? tokens.warning : segment.tone === 'muted' ? tokens.textMuted : tokens.textPrimary}>{segment.text}</Text>)}
          </Text>
        ))}
        {detailLines.length > detailSpan ? <Text color={tokens.textMuted} wrap="truncate-end">{[detailWin.above > 0 ? `↑ ${detailWin.above} more` : '', detailWin.below > 0 ? `↓ ${detailWin.below} more` : ''].filter(Boolean).join(' · ')}</Text> : null}
        <Box flexGrow={1} />
        <Text color={tokens.textMuted}>{cutToWidth(MCP_DETAIL_HINT, inner)}</Text>
      </Box>
    )
  }
  if (toolView) {
    const selectedTool = filteredTools[toolAt]
    const total = toolView.tools.length + toolView.omitted
    return (
      <Box ref={surface} flexDirection="column" width={width} height={height} borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} opaque flexShrink={0} {...(ground !== undefined ? { backgroundColor: ground } : {})}>
        <ProductLockup view="mcp" subtitle={inertLine(toolView.server)} separator=" · " />
        <Text color={tokens.textMuted} wrap="truncate-end">{toolView.reason !== null ? 'tools not listed' : `${total} ${total === 1 ? 'tool' : 'tools'} · this session${toolView.omitted > 0 ? ` · ${toolView.tools.length} shown, the rest past the ${kilobytes(MCP_TOOLS_ANSWER_BYTES)} read` : ''}`}</Text>
        <Box height={1} />
        {toolView.reason !== null ? reasonLines.slice(reasonWin.start, reasonWin.end).map((line, index) => <Text key={reasonWin.start + index} color={tokens.warning} wrap="truncate-end">{line === '' ? ' ' : line}</Text>) : null}
        {toolView.reason !== null && reasonLines.length > reasonSpan ? <Text color={tokens.textMuted} wrap="truncate-end">{[reasonWin.above > 0 ? `↑ ${reasonWin.above} more` : '', reasonWin.below > 0 ? `↓ ${reasonWin.below} more` : ''].filter(Boolean).join(' · ')}</Text> : null}
        <PopupListViewport above={toolWin.above} below={toolWin.below} rows={toolWin.end - toolWin.start}>
        {toolView.reason !== null ? null : filteredTools.length === 0 ? <Text color={tokens.textMuted}>{toolFilter ? 'No matching tools' : 'This server exposes no tools.'}</Text> : filteredTools.slice(toolWin.start, toolWin.end).map((tool, index) => {
          const selected = toolWin.start + index === toolAt
          const oneLine = inertLine(tool.description)
          const label = oneLine ? `${inertLine(tool.name)} · ${oneLine}` : inertLine(tool.name)
          return <InteractiveRow key={tool.name} id={`mcp:tool:${toolView.server}:${tool.name}`} selected={selected} onSelect={() => setToolCursor(toolWin.start + index)} onActivate={() => openTool(toolView, tool)} width={inner} height={1}><Text color={selected ? accent : tokens.textPrimary} wrap="truncate-end">{selected ? '› ' : '  '}{cutToWidth(label, Math.max(1, inner - 2))}</Text></InteractiveRow>
        })}
        </PopupListViewport>
        <Box flexGrow={1} />
        <Box minHeight={1} width={inner}><Text color={tokens.textMuted}>{selectedTool ? MCP_TOOL_LOADING_WORDS[selectedTool.loading] : ''}</Text></Box>
        <MenuFilterLine focused={toolFilterFocus} text={toolFilter} placeholder="filter tools" accent={accent} muted={tokens.textMuted} primary={tokens.textPrimary} />
        <Text color={tokens.textMuted}>{cutToWidth(MCP_TOOLS_HINT, inner)}</Text>
        <Text color={tokens.textMuted}>pgup/pgdn page</Text>
      </Box>
    )
  }
  return (
    <Box ref={surface} flexDirection="column" width={width} height={height} borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} opaque flexShrink={0} {...(ground !== undefined ? { backgroundColor: ground } : {})}>
      <ProductLockup view="mcp" separator=" · " />
      <Text color={tokens.textMuted}>{servers.length} servers · this session</Text>
      <Box height={1} />
      <PopupListViewport above={win.above} below={win.below} rows={win.end - win.start}>
      {rows.length === 0 ? <Text color={tokens.textMuted}>{filter ? 'No matching servers' : 'No MCP servers · mercury mcp add to add one'}</Text> : rows.slice(win.start, win.end).map((row, index) => {
        const selected = win.start + index === at
        const label = row.action
          ? `  ${row.action === 'disable' ? 'disable for this session' : row.action === 'enable' ? 'enable for this session' : row.action === 'tools' ? 'tools' : 'reconnect'}`
          : `${row.server.name} · ${stateOf(row.server)}${row.server.addedAt && Date.now() - row.server.addedAt < 60_000 ? ' · added just now' : ''}${expanded === row.server.name && row.server.type === 'connected' ? ` · ${row.server.toolCount ?? 0} tools` : ''}`
        return <InteractiveRow key={row.key} id={`mcp:${row.key}`} selected={selected} onSelect={() => setCursor(win.start + index)} onActivate={() => { void run(row) }} width={inner} height={1}><Text color={selected ? accent : tokens.textPrimary} wrap="truncate-end">{selected ? '› ' : '  '}{cutToWidth(label, Math.max(1, inner - 2))}</Text></InteractiveRow>
      })}
      </PopupListViewport>
      <Box flexGrow={1} />
      <Box minHeight={1} width={inner}><Text color={tokens.warning}>{detail}</Text></Box>
      <MenuFilterLine focused={filterFocus} text={filter} placeholder="filter by name" accent={accent} muted={tokens.textMuted} primary={tokens.textPrimary} />
      <Text color={tokens.textMuted}>{cutToWidth(MCP_POPUP_HINT, inner)}</Text>
      <Text color={tokens.textMuted}>pgup/pgdn page</Text>
    </Box>
  )
}
