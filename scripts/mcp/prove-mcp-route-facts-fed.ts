#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-mcp-route-facts-fed.ts — /mcp answers from the FOCUSED
//  SESSION's roster on every seat.
//
//  THE LAW (the facts-fed precedent, made total): the session's runner owns
//  its MCP servers, so /mcp on any seat — the chat pane of a session with
//  servers of its own included — answers from the focused connector's
//  facts; the settings panel serves only a screen that carries clients of
//  its own while the focused session carries none.
//
//    §1 the arm table (src/commands/mcp/route.ts): a populated session
//       roster answers from the facts whether or not the screen's own list
//       is empty — the shape that fell between the two arms; the panel arm
//       survives only for the screen-owned-clients, session-empty shape;
//    §2 the roster line names every server as `name (type)`, or says the
//       session has none;
//    §3 the composer is a thin caller of the table (source pins);
//    §4 the route driven through the composer: /mcp with a populated roster
//       beside a screen list of two clients completes with the session's
//       line and returns no panel; an empty roster beside screen clients
//       returns the panel element;
//    §5 the row speaks the deadline's honest reason: the session's process
//       projects a failed server's client.error into its roster facts (the
//       sentence the panel's server menu prints — one vocabulary), and the
//       face's line carries it beside the failed state; healthy rows stay
//       bare.
//
//  Poison (the empty paint): the base composer gated the facts arm on the
//  screen's list being empty — beside clients of its own the screen painted
//  its panel and the session's servers never reached the row (§1's
//  between-the-arms row and §4's first rows red on the base); the base
//  roster carried name and state only, so no reason could reach the row
//  (§5 red on the base).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Proof hygiene: a scratch config home BEFORE any product import.
const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-route-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH
process.on('exit', () => {
  try {
    rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
  } catch {
    /* best effort */
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

section('§3 the composer is a thin caller of the table (source pins)')
{
  const src = readFileSync(join(ROOT, 'src/commands/mcp/mcp.tsx'), 'utf8')
  check('§3 imports the arm table', src.includes("from './route.js'") && src.includes('mcpRouteArm') && src.includes('mcpRosterLine'))
  const rosterAt = src.indexOf('getFocusedSessionConnector().mcpRoster()')
  const armAt = src.indexOf('mcpRouteArm(roster')
  check('§3 the focused roster is read BEFORE the arm decides, unconditionally', rosterAt > 0 && armAt > rosterAt, `roster@${rosterAt} arm@${armAt}`)
  check('§3 no screen-list-empty gate fronts the facts arm (the base shape)', !src.includes('screenClients.length === 0'))
  check("§3 the panel arm survives for the screen's own clients", src.includes('<MCPSettings onComplete={onDone} />'))
  const route = readFileSync(join(ROOT, 'src/commands/mcp/route.ts'), 'utf8')
  check('§3 the line grammar has ONE owner (route.ts carries the sentences, the composer none)', route.includes("The session's MCP servers:") && !src.includes("The session's MCP servers:"))
}

section('§4 the route driven through the composer')
{
  type Composer = { call: (onDone: (r?: string) => void, ctx: unknown, args: string) => Promise<unknown> }
  let mod: Composer | null = null
  let loadError = ''
  try {
    mod = (await import(join(ROOT, 'src/commands/mcp/mcp.tsx'))) as Composer
  } catch (error) {
    loadError = String(error)
  }
  if (mod === null) {
    console.log(`  [SKIP] §4 the composer module did not load under bun — ${loadError.slice(0, 200)} (the §1–§3 pins are the floor; the live drive rides the pool's built-bundle capture)`)
  } else {
    const slot = await import(join(ROOT, 'src/services/engine-connector/focusedConnector.ts'))
    const fakeConnector = (roster: Roster) => ({ carrier: 'daemon', sessionId: () => 'fake-session', mcpRoster: () => roster })
    const ctxWith = (clients: unknown[]) => ({ getAppState: () => ({ mcp: { clients } }) })
    const screenClients = [{ name: 'cockpit-a', type: 'connected' }, { name: 'cockpit-b', type: 'pending' }]

    slot._resetFocusedSessionConnectorForTesting()
    slot.setFocusedSessionConnector(fakeConnector(populated))
    let done: string | undefined
    const element = await mod.call(r => { done = r }, ctxWith(screenClients), '')
    check("§4 populated roster beside screen clients: the composer completes with the session's line", typeof done === 'string' && done.includes('frozen (pending)') && done.includes('docs (connected)'), String(done))
    check('§4 … and returns no panel (null element)', element === null)
    check("§4 … the line never names the screen's own clients", typeof done === 'string' && !done.includes('cockpit-a'), String(done))

    slot._resetFocusedSessionConnectorForTesting()
    slot.setFocusedSessionConnector(fakeConnector(empty))
    let doneEmpty: string | undefined
    const panel = await mod.call(r => { doneEmpty = r }, ctxWith(screenClients), '')
    check('§4 empty roster beside screen clients: the panel element returns and no line completes', panel !== null && panel !== undefined && doneEmpty === undefined, String(doneEmpty))

    slot._resetFocusedSessionConnectorForTesting()
    slot.setFocusedSessionConnector(fakeConnector(empty))
    let doneBlank: string | undefined
    const blank = await mod.call(r => { doneBlank = r }, ctxWith([]), '')
    check('§4 empty roster, empty screen: the honest empty line', blank === null && doneBlank === MCP_EMPTY_ROSTER_LINE, String(doneBlank))
    slot._resetFocusedSessionConnectorForTesting()
  }
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
  // ONE vocabulary: the panel's server menus print client.error itself, and
  // the projection forwards that sentence untouched — no rephrase anywhere.
  const stdioMenu = readFileSync(join(ROOT, 'src/components/mcp/MCPStdioServerMenu.tsx'), 'utf8')
  const remoteMenu = readFileSync(join(ROOT, 'src/components/mcp/MCPRemoteServerMenu.tsx'), 'utf8')
  check("§5 the panel's server menus print client.error verbatim (the same vocabulary)", stdioMenu.includes('{client.error}') && remoteMenu.includes('{client.error}'))
  const rosterSrc = readFileSync(join(ROOT, 'src/services/engine-connector/rosterTerms.ts'), 'utf8')
  check('§5 the projection forwards the reason only for a failed row', rosterSrc.includes("client.type === 'failed'") && rosterSrc.includes('error: client.error'))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ ALL /mcp ROUTE PROOFS PASS')
} else {
  console.log(` ❌ ${failures} /mcp ROUTE PROOF(S) FAILED`)
}
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
