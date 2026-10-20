#!/usr/bin/env bun
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('mcp-tools-views')
delete process.env.MERCURY_HOME
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.BROWSER = '/usr/bin/true'

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 1600)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the mcp tools views proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

const React = await import('react')
const { App } = await import('../../src/components/App.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { PopupFrameContext } = await import('../../src/components/PopupGutter.js')
const { McpPopup } = await import('../../src/commands/mcp/McpPopup.js')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.js')
const h = React.createElement

const FRAME = { width: 78, rows: 12 }
const OLDER_DAEMON = 'the daemon is an older build (protocol 15, v1.0.0-beta.39; this Mercury speaks 16): `sessionControl mcp-tools` needs protocol 16; restart the daemon: `mercury daemon restart` — and, when the session was opened before the update, stop and resume it so its runner speaks the same build as this screen and the daemon; the list reads again once both are current.'

let answer: unknown = null
const roster = { clients: [{ name: 'runpod', type: 'connected', toolCount: 300 }] }
const connector = new Proxy(
  {
    mcpRoster: () => roster,
    mcpTools: async () => answer,
    mcpAction: async () => ({ outcome: 'applied' }),
    setKit: async () => ({ outcome: 'applied' }),
    subscribeModel: () => () => {},
    sessionId: () => 'proof-session',
  } as Record<string, unknown>,
  { get: (target, prop) => (typeof prop === 'string' && prop in target ? target[prop] : () => undefined) },
)
setFocusedSessionConnector(connector as never)

function frameOf(lines: string[]): { rows: number; lastRow: string; body: string[] } | null {
  const at = lines.findIndex(line => line.includes('Mercury · mcp'))
  if (at < 1) return null
  const col = lines[at - 1]!.indexOf('╭')
  if (col < 0) return null
  const bottom = lines.findIndex((line, row) => row > at && line[col] === '╰')
  if (bottom < 0) return null
  return { rows: bottom - at + 2, lastRow: lines[bottom - 1] ?? '', body: lines.slice(at, bottom) }
}

async function mounted(): Promise<Awaited<ReturnType<typeof mountOffscreen>>> {
  const m = await mountOffscreen(
    h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(PopupFrameContext.Provider, { value: FRAME }, h(McpPopup, { onDone: () => {} }))),
    100,
    30,
  )
  await waitFor(() => m.screen().includes('runpod · connected'), 10_000)
  await settle(300)
  return m
}

async function press(m: Awaited<ReturnType<typeof mountOffscreen>>, data: string, until: string, ms = 5_000): Promise<boolean> {
  m.push(data)
  const seen = await waitFor(() => m.screen().includes(until), ms)
  await settle(120)
  return seen
}

section('§1 a server the session cannot list: the popup says why, inside its one grant, and the way back stays on screen')
{
  answer = { server: 'runpod', state: 'unavailable', tools: [], omitted: 0, detail: OLDER_DAEMON }
  const m = await mounted()
  const unfolded = await press(m, KEY.enter, '  tools')
  check('↵ unfolds the connected server with its tools row', unfolded, m.screen())
  await press(m, KEY.down, '›   tools')
  const reasonShown = await press(m, KEY.enter, 'tools not listed')
  const lines = m.lines()
  const frame = frameOf(lines)
  check("the reason replaces the list — never 'This server exposes no tools.'", reasonShown && lines.some(line => line.includes('the daemon is an older build (protocol 15')) && !m.screen().includes('This server exposes no tools.'), m.screen())
  check('the reason view stays inside the 12-row grant with its way back on the last row', frame !== null && frame.rows === FRAME.rows && frame.lastRow.includes('esc back to servers'), m.screen())
  check('a reason longer than the grant is marked ↓, never pushed past the frame', frame !== null && frame.body.some(line => /↓ \d+ more/.test(line)), m.screen())
  const scrolled = await press(m, KEY.down, '↑ 1 more')
  check('↓ scrolls the reason and marks what scrolled off ↑', scrolled && frameOf(m.lines())?.lastRow.includes('esc back to servers') === true, m.screen())
  const back = await press(m, KEY.esc, '1 servers · this session')
  check('esc steps back to the server list (the popup stays open)', back && m.screen().includes('esc or click outside closes'), m.screen())
  m.unmount()
}

section('§2 the marks of a bounded answer reach the screen: omitted tools, a held tool, a cut description, a withheld schema')
{
  const words = Array.from({ length: 30 }, (_, i) => `Clause ${i + 1} of a long tool description that keeps going.`).join(' ')
  answer = {
    server: 'runpod',
    state: 'connected',
    omitted: 297,
    tools: [
      { name: 'late_joiner', registeredAs: 'mcp__runpod__late_joiner', description: `${words}…`, descriptionCut: true, inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, loading: 'held' },
      { name: 'huge_schema', registeredAs: 'mcp__runpod__huge_schema', description: 'A tool whose schema is too large to carry.', inputSchema: {}, schemaWithheldBytes: 204_800, loading: 'deferred' },
      { name: 'plain_tool', registeredAs: 'mcp__runpod__plain_tool', description: 'Always in the tool list.', inputSchema: { type: 'object', properties: {} }, loading: 'listed' },
    ],
  }
  const m = await mounted()
  await press(m, KEY.enter, '  tools')
  await press(m, KEY.down, '›   tools')
  const listed = await press(m, KEY.enter, 'late_joiner')
  const screen = m.screen()
  check('the count names every tool the session has, and how many crossed the bound', listed && screen.includes('300 tools · this session · 3 shown, the rest past the 512 KB read'), screen)
  check("a held tool says so on the status line (the model cannot call it until the next compaction or /clear)", screen.includes('held · joins the tool list at the next compaction or /clear'), screen)
  check('the list stays inside the grant with its way back on the last row', frameOf(m.lines())?.rows === FRAME.rows && frameOf(m.lines())?.lastRow.includes('esc back to servers') === true, screen)
  const opened = await press(m, KEY.enter, 'mcp__runpod__late_joiner · held')
  check('the detail names the tool as the model calls it, and its loading', opened, m.screen())
  const ended = await press(m, '\x1b[F', '(the description is cut at 8,192 characters)')
  check('a cut description is marked at its end, inside the grant', ended && frameOf(m.lines())?.rows === FRAME.rows && frameOf(m.lines())?.lastRow.includes('esc back to tools') === true, m.screen())
  await press(m, KEY.esc, 'late_joiner ·')
  await press(m, KEY.down, 'deferred · schema loads on demand')
  const withheld = await press(m, KEY.enter, 'did not fit this view')
  check("a withheld schema says so with its size instead of an empty parameter list", withheld && m.screen().includes('The input schema (200 KB)') && !m.screen().includes('Parameters'), m.screen())
  m.unmount()
}

releaseFocusedSessionConnector()
console.log(`\n${checks - failures}/${checks} checks passed; ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures === 0 ? 0 : 1)
