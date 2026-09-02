#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-mcp-failure-surfaces.ts — every MCP failure has a
//  surface that holds it and a next step beside it.
//
//  The class: a failure the product knew about reached the operator bare —
//  the /mcp answer on a hosted seat painted on the one-row footer notice
//  (seven servers' reasons clipped past the row); a server that died after
//  connecting was re-marked failed with no reason; a tool call that died
//  mid-call or hit the SDK's deadline surfaced as the bare protocol
//  sentence; the /skills dial listed rows below the fold with no marker.
//
//   §1  the /mcp CARD: the facts arm renders a card on every seat when the
//       roster has rows (the one-line answer stays for an empty roster); the
//       card's rows ride the failed-first order and the detail line paints
//       the selected row's reason whole, with its retry verb.
//   §2  the mid-call sentences name the server and the next step.
//   §3  every failed re-mark in src carries a reason (the roster row forwards
//       `error` only when it is there — a mint without it is the bare row).
//   §4  the /skills dial rides the cursor-following window with its markers.
//
//  Run:  ~/.bun/bin/bun run scripts/mcp/prove-mcp-failure-surfaces.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail && !cond ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${t}`)
}

section('§1 the /mcp answer is a card on every seat')
{
  const card = await import(join(ROOT, 'src/components/mcp/McpRosterCard.tsx'))
  const failed = { name: 'dies', type: 'failed' as const, error: 'MCP error -32000: Connection closed — server stderr: boot failed: missing API key' }
  const bare = { name: 'mute', type: 'failed' as const }
  const disabled = { name: 'off', type: 'disabled' as const }
  const pending = { name: 'slow', type: 'pending' as const }
  const connected = { name: 'ok', type: 'connected' as const }
  check('a row is the name and its state; the reason never rides the row', card.mcpRosterCardRow(failed) === 'dies · failed' && card.mcpRosterCardRow(connected) === 'ok · connected')
  check("a failed row's detail is its own reason and the retry verb", card.mcpRosterCardDetail(failed) === `${failed.error} · /mcp reconnect dies retries`)
  check('a failed row with no recorded reason says so instead of standing bare', card.mcpRosterCardDetail(bare) === 'failed — no reason was recorded · /mcp reconnect mute retries')
  check('a disabled row names its on-dial', card.mcpRosterCardDetail(disabled) === 'off in this session · /mcp enable off turns it on')
  check('a pending row says it is connecting', card.mcpRosterCardDetail(pending) === 'connecting…')
  check('a connected row names its off-dial', card.mcpRosterCardDetail(connected) === 'connected · /mcp disable ok turns it off for this session')
  check('no selection paints an empty detail', card.mcpRosterCardDetail(null) === '')
  const cardSrc = read('src/components/mcp/McpRosterCard.tsx')
  check('the card lists the failed rows first (the route owner orders them)', cardSrc.includes('mcpRosterRowsFailedFirst(roster)'))
  check('the card windows long rosters with overflow counters', cardSrc.includes('paneWindow(rows.length, list.selectedIndex, rowCap)') && cardSrc.includes('↑ {win.above} more') && cardSrc.includes('↓ {win.below} more'))
  check("the card's close echoes nothing onto the footer behind it", cardSrc.includes("onDone(undefined, { display: 'skip' })"))
  const mcpSrc = read('src/commands/mcp/mcp.tsx')
  const factsArm = mcpSrc.slice(mcpSrc.indexOf("=== 'facts') {"), mcpSrc.indexOf('return <MCPSettings'))
  check('the facts arm renders the card when the roster has rows', factsArm.includes('return <McpRosterCard roster={roster} onDone={onDone} />'))
  check('an empty roster keeps its one honest line', factsArm.includes('if (roster.clients.length === 0) {') && factsArm.includes('onDone(mcpRosterLine(roster))'))
}

section('§2 a tool call that dies mid-call names the server and the next step')
{
  const clientSrc = read('src/services/mcp/client.ts')
  const callFn = clientSrc.slice(clientSrc.indexOf("method: 'tools/call'"), clientSrc.indexOf('type UrlElicitation ='))
  check('a connection closed mid-call is wrapped with the server and the reconnect verb', callFn.includes('if (isConnectionClosedError(err)) {') && callFn.includes('failed: the server closed the connection mid-call — /mcp shows its state; /mcp reconnect ${connected.name} starts it again'))
  check("the SDK's request deadline is wrapped with the seconds, the knob and the next step", callFn.includes('err.code === ErrorCode.RequestTimeout') && callFn.includes('failed: no answer within ${Math.round(timeoutMs / 1000)}s (MCP_TOOL_TIMEOUT) — retry, or raise MCP_TOOL_TIMEOUT for a slow tool'))
  const closedAt = callFn.indexOf('if (isConnectionClosedError(err)) {')
  const expiredAt = callFn.indexOf('throw new McpSessionExpiredError(connected.name)')
  const finalThrow = callFn.lastIndexOf('    throw err\n  } finally {')
  check("the wraps sit after the http session-expired route and before the bare rethrow", expiredAt < closedAt && closedAt < finalThrow)
}

section('§3 every failed re-mark carries a reason')
{
  const mainSrc = read('src/main.tsx')
  check("the interactive mount's connect-failure re-mark carries the failure's own sentence", mainSrc.includes("entry.name === name ? { name, type: 'failed' as const, config, error: reason } : entry"))
  const registrySrc = read('src/services/mcp/registry/serverRegistry.ts')
  check('a lost local connection is re-marked with why and the retry verb', registrySrc.includes('error: `the server closed its connection — a local server is not restarted on its own; /mcp reconnect ${name} starts it again`'))
  const menuSrc = read('src/components/mcp/MCPRemoteServerMenu.tsx')
  check('a cleared sign-in names itself on the failed row', menuSrc.includes('error: `signed out of ${server.name} — /mcp reconnect ${server.name} signs in again`'))
  // The census: every failed-row literal in src carries an error key within
  // its own braces (a mint without one is the bare "(failed)" row).
  const { execSync } = await import('node:child_process')
  const files = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx'", { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  const bareMints: string[] = []
  for (const file of files) {
    const src = readFileSync(join(ROOT, file), 'utf8')
    const re = /\{[^{}]*type: 'failed'(?: as const)?[^{}]*\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const literal = m[0]
      // A type declaration (`type: 'failed'` beside other field types) is not a mint.
      if (/\btype: 'failed'\s*\n\s+\w+\??:/.test(literal) || /^\{\s*type: 'failed';/.test(literal)) continue
      if (!/\berror\b/.test(literal)) bareMints.push(`${file}: ${literal.replace(/\s+/g, ' ').slice(0, 90)}`)
    }
  }
  check('no failed-row literal in src is minted without a reason', bareMints.length === 0, bareMints.join(' | '))
  const termsSrc = read('src/services/engine-connector/rosterTerms.ts')
  check("the roster row forwards a failed row's reason (the seam the card and the line read)", termsSrc.includes("client.type === 'failed' && client.error !== undefined && client.error !== ''"))
}

section('§4 the /skills dial windows its rows')
{
  const dialSrc = read('src/components/skills/SessionSkillsDial.tsx')
  check('the dial rides the cursor-following window', dialSrc.includes('paneWindow(skills.length, list.selectedIndex, rowCap)'))
  check('rows outside the window are not painted', dialSrc.includes('if (i < win.start || i >= win.end) return null'))
  check('the overflow counters paint above and below', dialSrc.includes('↑ {win.above} more') && dialSrc.includes('↓ {win.below} more'))
  check('the window budgets the modal pane when inside one', dialSrc.includes('useModalOrTerminalSize({ rows: termRows, columns }).rows'))
}

if (failures > 0) {
  console.log(`\n ❌ mcp-failure-surfaces — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ mcp-failure-surfaces — the card, the mid-call sentences, every failed re-mark with its reason, the dial window')
