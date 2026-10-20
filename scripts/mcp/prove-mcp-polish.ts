import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { gridToPng } from '../ui/gridToPng.ts'

const home = process.env.MERCURY_CONFIG_DIR
if (!home) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
let failures = 0
const check = (name: string, ok: unknown) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failures++ }
try {
  const React = await import('react')
  const { Box, Text } = await import('../../src/ink.ts')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { CommandPopupSlot, commandPopupGeometry } = await import('../../src/components/CommandPopupSlot.tsx')
  const claims = await import('../../src/utils/cockpit/commandPopup.ts')
  const { call } = await import('../../src/commands/mcp/mcp.tsx')
  const { getFocusedSessionConnector, setFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
  const previous = getFocusedSessionConnector()
  let reason: string | undefined
  const tools = Array.from({ length: 12 }, (_, index) => ({ name: 'fixture_tool_' + String(index).padStart(2, '0'), registeredAs: 'mcp__fixture__tool_' + index, description: Array.from({ length: 18 }, (_, row) => 'Description line ' + row + ': inspect the chosen file without modifying it.').join('\n'), loading: 'deferred' as const, inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 20 }, (_, field) => ['field' + field, { type: 'string', description: 'Parameter ' + field }])) } }))
  setFocusedSessionConnector(new Proxy(previous, { get(target, key) {
    if (key === 'mcpRoster') return () => ({ clients: [{ name: 'fixture', type: 'connected', toolCount: tools.length }] })
    if (key === 'mcpTools') return async () => ({ server: 'fixture', state: reason ? 'unavailable' : 'connected', tools: reason ? [] : tools, omitted: 0, ...(reason ? { detail: reason } : {}) })
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }))
  try {
    for (const cols of [120, 80]) {
      let closed = false
      let view: React.ReactNode = await call(() => { closed = true }, {} as never, '')
      const originalToken = claims.commandPopupClaim()!.token
      function Screen() {
        const host = React.useRef<any>(null)
        const claim = React.useSyncExternalStore(claims.subscribeCommandPopup, claims.commandPopupClaim, claims.commandPopupClaim)
        return React.createElement(ThemeProvider, {}, React.createElement(Box, { ref: host, width: cols, height: 40, flexDirection: 'column' }, ...Array.from({ length: 40 }, (_, row) => React.createElement(Text, { key: row }, ('chat background ' + row).padEnd(cols, '.'))), claim ? React.createElement(CommandPopupSlot, { hostRef: host, framed: false, scrollRef: null, shape: claim.shape }, view) : null))
      }
      const m = await mountOffscreen(React.createElement(Screen), cols, 40)
      const until = async (text: string) => assert.ok(await waitFor(() => m.screen().includes(text), 5000), m.screen())
      const capture = async (name: string) => {
        if (!frames) return
        writeFileSync(join(frames, name + '-' + cols + '.txt'), m.screen())
        const grid = m.lines().map((line, y) => Array.from(line.padEnd(cols)).map((c, x) => { const s = m.styleAt(x, y); return { c, bg: s?.bg ?? 'default', fg: s?.fg ?? 'default', bold: s?.bold ?? false, rev: s?.inverse ?? false } }))
        const path = join(frames, name + '-' + cols + '.json')
        writeFileSync(path, JSON.stringify({ grid, cols, rows: 40 }))
        await gridToPng(path, join(frames, name + '-' + cols + '.png'))
      }
      const geometry = () => commandPopupGeometry({ left: 0, top: 0, columns: cols, rows: 40 }, 40, claims.commandPopupClaim()!.shape)
      const openTools = async () => { if (!m.screen().includes('disable for this session')) { m.push(KEY.enter); await until('disable for this session') } if (!m.screen().includes('›   tools')) { m.push(KEY.down); await until('›   tools') } m.push(KEY.enter); await until('esc back to servers') }
      try {
        await until('fixture · connected'); const initial = geometry(); await capture('mcp-servers')
        await openTools(); await capture('mcp-tools')
        const grown = geometry()
        check(cols + ': tools gain reading room without taking another popup grant', grown.rows > initial.rows && claims.commandPopupClaim()!.token === originalToken)
        check(cols + ': list shows at least ten tools at a time', m.lines().filter(line => line.includes('fixture_tool_')).length >= 10)
        console.log('MEASURE mcp ' + cols + ': servers=' + initial.rows + ' list=' + grown.rows + ' tool rows=' + m.lines().filter(line => line.includes('fixture_tool_')).length)
        m.push(KEY.enter); await until('esc back to tools'); await capture('mcp-detail')
        check(cols + ': detail has at least ten readable rows', m.lines().filter(line => line.includes('Description line')).length >= 10)
        m.push('\x1b[F'); await until('field19'); await capture('mcp-detail-end')
        m.push(KEY.esc); await until('esc back to servers'); await capture('mcp-tools-return')
        m.push(KEY.esc); await until('1 servers · this session'); await capture('mcp-servers-return')
        check(cols + ': returning never shrinks the open popup or leaves detail cells', geometry().rows === grown.rows && !m.screen().includes('field19') && !m.screen().includes('Description line'))
        check(cols + ': content outside the popup still belongs to the chat', m.lines()[0]?.includes('chat background 0') && m.lines()[39]?.includes('chat background 39'))
        for (const [label, failure] of [['older', 'the runner is older than the mcp-tools verb'], ['disconnected', 'fixture is not connected'], ['no-chat', 'no chat is open — ↵ New Session on the boot menu starts one']]) {
          reason = failure
          await openTools(); await capture('mcp-' + label)
          const plain = m.lines().map(line => line.replaceAll('│', '')).join(' ').replace(/\s+/g, ' ')
          check(cols + ': ' + label + ' reads as a sentence with a way back', plain.includes('esc back to servers') && (label === 'older' ? plain.includes('Run /restart') : label === 'disconnected' ? plain.includes('Reconnect') : plain.includes('New Session')) && !plain.includes('mcp-tools verb'))
          m.push(KEY.esc); await until('1 servers · this session')
        }
        reason = undefined
        m.push(KEY.esc); assert.ok(await waitFor(() => closed, 3000))
      } finally { m.unmount(); claims.releaseCommandPopup(originalToken) }
    }
  } finally { setFocusedSessionConnector(previous) }
  console.log('MCP POLISH ' + (failures ? 'RED' : 'GREEN') + ' — ' + failures + ' failures')
  process.exitCode = failures ? 1 : 0
} finally { f.close() }
