#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-route-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH
process.on('exit', () => {
  try {
    rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
  } catch {
  }
})

const ROOT = join(import.meta.dir, '..', '..')
const { mcpRouteArm, mcpRosterLine, MCP_EMPTY_ROSTER_LINE } = await import(join(ROOT, 'src/commands/mcp/route.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Roster = { clients: Array<{ name: string; type: string; error?: string }> }
const populated: Roster = { clients: [{ name: 'frozen', type: 'pending' }, { name: 'docs', type: 'connected' }] }
const empty: Roster = { clients: [] }

console.log('============================================================')
console.log(" /mcp answers from the focused session's roster — proof")
console.log('============================================================')

section("§1 the arm table — the session's facts win on every seat")
{
  check('§1 populated roster, empty screen list → facts', mcpRouteArm(populated, 0) === 'facts')
  check('§1 populated roster beside TWO screen clients → facts (the between-the-arms shape)', mcpRouteArm(populated, 2) === 'facts')
  check('§1 empty roster, empty screen list → facts (the honest empty line)', mcpRouteArm(empty, 0) === 'facts')
  check("§1 empty roster beside screen clients → the screen's own panel", mcpRouteArm(empty, 2) === 'panel')
}

section('§2 the roster line')
{
  check('§2 the empty roster says so', mcpRosterLine(empty) === MCP_EMPTY_ROSTER_LINE, mcpRosterLine(empty))
  const line = mcpRosterLine(populated)
  check('§2 every server rides as `name (type)`', line.includes('frozen (pending)') && line.includes('docs (connected)'), line)
  check('§2 rows join with a middle dot', line.includes('frozen (pending) · docs (connected)'), line)
  check('§2 the line names the owner and the toggle door', line.includes("The session's runner owns them") && line.includes('/mcp enable|disable <name>'), line)
}

section('§3 the composer leases the focused session popup on every seat')
{
  const src = readFileSync(join(ROOT, 'src/commands/mcp/mcp.tsx'), 'utf8')
  check('§3 the focused roster determines the popup grant', src.includes('mcpPopupShapeFor(getFocusedSessionConnector().mcpRoster().clients.length)'))
  check('§3 the composer returns the popup under its lease', src.includes('<CommandPopupLease token={token}><MCPSettings onComplete={onDone} /></CommandPopupLease>'))
  check('§3 no screen-list-empty gate fronts the focused roster', !src.includes('screenClients.length === 0'))
  const popup = readFileSync(join(ROOT, 'src/commands/mcp/McpPopup.tsx'), 'utf8')
  check('§3 the popup subscribes to and reads the focused connector', popup.includes('subscribeThroughFocused') && popup.includes('mcpRosterRowsFailedFirst(connector.mcpRoster())'))
}

section('§4 the focused roster is painted through the composer')
{
  const React = await import('react')
  const { App } = await import('../../src/components/App.js')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
  const { enableConfigs } = await import('../../src/utils/config.js')
  const { mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.ts')
  const mod = await import('../../src/commands/mcp/mcp.tsx')
  const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
  enableConfigs()
  const screenClients = [{ name: 'cockpit-a', type: 'connected' }, { name: 'cockpit-b', type: 'pending' }]
  for (const [label, roster, clients] of [
    ['populated beside screen clients', populated, screenClients],
    ['empty beside screen clients', empty, screenClients],
    ['empty beside an empty screen', empty, []],
  ] as const) {
    const connector = new Proxy({
      carrier: 'daemon', sessionId: () => 'fake-session', mcpRoster: () => roster,
      subscribeModel: () => () => {},
    } as Record<string, unknown>, { get: (target, key) => typeof key === 'string' && key in target ? target[key] : () => undefined })
    slot._resetFocusedSessionConnectorForTesting()
    slot.setFocusedSessionConnector(connector as never)
    let done: string | undefined
    const element = await mod.call(result => { done = result }, { getAppState: () => ({ mcp: { clients } }) } as never, '')
    check('§4 ' + label + ': returns a popup without completing synchronously', element != null && done === undefined)
    const mounted = await mountOffscreen(React.createElement(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, element), 100, 30)
    try {
      const needle = roster.clients.length ? 'docs · connected' : 'No MCP servers'
      check('§4 ' + label + ': the popup carries the focused roster', await waitFor(() => mounted.screen().includes(needle), 10_000), mounted.screen())
      check('§4 ' + label + ': never paints the screen clients', !mounted.screen().includes('cockpit-a') && !mounted.screen().includes('cockpit-b'), mounted.screen())
      if (roster.clients.length) check('§4 the pending session server also paints', mounted.screen().includes('frozen'), mounted.screen())
    } finally { mounted.unmount() }
  }
  slot._resetFocusedSessionConnectorForTesting()
}

section("§5 the row speaks the deadline's honest reason (the panel's own words)")
{
  const { mcpRosterEntriesOf } = await import(join(ROOT, 'src/services/engine-connector/rosterTerms.ts'))
  const REASON = 'MCP server "frozen" (stdio) did not answer in 30s — retry from /mcp'
  const failed = { type: 'failed', name: 'frozen', config: { type: 'stdio', command: 'x', scope: 'project' }, error: REASON }
  const connected = { type: 'connected', name: 'docs', config: { type: 'stdio', command: 'y', scope: 'project' }, client: {}, capabilities: null }
  const pending = { type: 'pending', name: 'slow', config: { type: 'sse', url: 'http://127.0.0.1:1', scope: 'project' } }
  const rows = mcpRosterEntriesOf([failed, connected, pending], []) as Array<{ name: string; type: string; error?: string }>
  const failedRow = rows.find(r => r.name === 'frozen')
  check('§5 the failed row projects the reason verbatim', failedRow !== undefined && failedRow.error === REASON, JSON.stringify(failedRow))
  check('§5 a connected row carries no reason key', !('error' in (rows.find(r => r.name === 'docs') ?? {})), JSON.stringify(rows))
  check('§5 a pending row carries no reason key', !('error' in (rows.find(r => r.name === 'slow') ?? {})), JSON.stringify(rows))
  const line = mcpRosterLine({ clients: rows })
  check('§5 the face line carries the reason beside the failed state', line.includes(`frozen (failed) — ${REASON}`), line)
  check('§5 … and the healthy rows stay bare', line.includes('docs (connected) · slow (pending)'), line)
  const { mcpServerState } = await import('../../src/commands/mcp/McpPopup.tsx')
  check("§5 the popup carries the failed client's own reason", mcpServerState(failed as never) === 'failed: ' + REASON)
  const rosterSrc = readFileSync(join(ROOT, 'src/services/engine-connector/rosterTerms.ts'), 'utf8')
  check('§5 the projection forwards the reason only for a failed row', rosterSrc.includes("client.type === 'failed'") && rosterSrc.includes('error: client.error'))
}

section('§6 the failed rows lead the line')
{
  const { mcpRosterRowsFailedFirst } = await import(join(ROOT, 'src/commands/mcp/route.ts'))
  const roster = {
    clients: [
      { name: 'a', type: 'connected' },
      { name: 'b', type: 'failed', error: 'command not found: /x — check the path' },
      { name: 'c', type: 'pending' },
      { name: 'd', type: 'failed', error: 'connection refused at 127.0.0.1:9' },
    ],
  }
  const ordered = mcpRosterRowsFailedFirst(roster as never).map((r: { name: string }) => r.name)
  check('§6 every failed row first, roster order kept on both sides', JSON.stringify(ordered) === JSON.stringify(['b', 'd', 'a', 'c']), ordered.join(','))
  const line = mcpRosterLine(roster as never)
  check('§6 the line opens with the first failure and its reason', line.startsWith("The session's MCP servers: b (failed) — command not found: /x — check the path · d (failed) — connection refused at 127.0.0.1:9 · a (connected) · c (pending)"), line)
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ ALL /mcp ROUTE PROOFS PASS')
} else {
  console.log(` ❌ ${failures} /mcp ROUTE PROOF(S) FAILED`)
}
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
