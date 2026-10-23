#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
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

section('§1 the /mcp answer is the popup on every seat')
{
  const popup = await import(join(ROOT, 'src/commands/mcp/McpPopup.tsx'))
  const failed = { name: 'dies', type: 'failed' as const, error: 'MCP error -32000: Connection closed — server stderr: boot failed: missing API key' }
  const bare = { name: 'mute', type: 'failed' as const }
  const disabled = { name: 'off', type: 'disabled' as const }
  const pending = { name: 'slow', type: 'pending' as const }
  const connected = { name: 'ok', type: 'connected' as const }
  const needsAuth = { name: 'runpod', type: 'needs-auth' as const }
  const signingIn = { name: 'runpod', type: 'needs-auth' as const, signingIn: true }
  check("a failed row's state carries its own reason", popup.mcpServerState(failed) === `failed: ${failed.error}`)
  check('a failed row with no recorded reason says so instead of standing bare', popup.mcpServerState(bare) === 'failed: connection failed')
  check('a disabled row reads off', popup.mcpServerState(disabled) === 'off')
  check('a pending row says it is connecting', popup.mcpServerState(pending) === 'connecting…')
  check('a connected row reads connected', popup.mcpServerState(connected) === 'connected')
  check('a row that needs sign-in says so (↵ signs in)', popup.mcpServerState(needsAuth) === 'needs sign-in')
  check('a row mid sign-in names the browser', popup.mcpServerState(signingIn) === 'signing in… (browser)')
  const popupSrc = read('src/commands/mcp/McpPopup.tsx')
  check("the selected failed row's reason paints whole on the detail line", popupSrc.includes("rows[at]?.server.type === 'failed' ? rows[at]?.server.error ?? 'connection failed' : ''"))
  check('the popup lists the failed rows first (the route owner orders them)', popupSrc.includes('mcpRosterRowsFailedFirst('))
  check('the popup windows long rosters', popupSrc.includes('paneWindow(rows.length, at, Math.max(1, height - MCP_POPUP_CHROME_ROWS))') && popupSrc.includes('MCP_POPUP_CHROME_ROWS + Math.max(1, serverCount) + MCP_POPUP_UNFOLD_ROWS') && popupSrc.includes('rows.slice(win.start, win.end)'))
  check('↵ on a row acts: sign in, reconnect, or unfold the dials', popupSrc.includes("auth ? 'authenticate' : 'reconnect'") && popupSrc.includes("connector.setKit({ mcp: [{ name: server.name, on: action === 'enable' }] })"))
  check('a sign-in left mid-flight is cancelled when the popup closes', popupSrc.includes("void connector.mcpAction(signingIn.current, 'cancel-auth')"))
  check('esc closes with no footer echo', popupSrc.includes('if (key.escape) { onDone(); return }'))
  check('an empty roster keeps its one honest line', popupSrc.includes("'No MCP servers · mercury mcp add to add one'"))
  const mcpSrc = read('src/commands/mcp/mcp.tsx')
  check('the /mcp command opens the popup under the command-popup lease', mcpSrc.includes('<CommandPopupLease token={token}><MCPSettings onComplete={onDone} /></CommandPopupLease>'))
  const settingsSrc = read('src/components/mcp/MCPSettings.tsx')
  check('the settings surface is the popup (one /mcp, not two)', settingsSrc.includes("import { McpPopup } from '../../commands/mcp/McpPopup.js'"))
}

section('§2 a tool call that dies mid-call names the server and the next step')
{
  const clientSrc = read('src/services/mcp/client.ts')
  const callFn = clientSrc.slice(clientSrc.indexOf('async function callToolOnce('), clientSrc.indexOf('type UrlElicitation ='))
  check('an uncertain call names the server, tool and inspection before retry', callFn.includes('MCP tool "${tool}" on server "${connected.name}": unknown outcome; inspect the effect before retrying.'))
  check('only unsent or explicitly rejected requests can replay', callFn.includes('isMcpSessionExpiredError(err) || (err instanceof SdkError && err.code === SdkErrorCode.NotConnected)'))
  check('lost responses and deadlines retain error status', callFn.includes('if (couldHaveExecuted && !(err instanceof ProtocolError))') && callFn.includes('throw unknownOutcome()'))
}

section('§3 every failed re-mark carries a reason')
{
  const mainSrc = read('src/main.tsx')
  check("the interactive mount's connect-failure re-mark carries the failure's own sentence", mainSrc.includes("entry.name === name ? { name, type: 'failed' as const, config, error: reason } : entry"))
  const registrySrc = read('src/services/mcp/registry/serverRegistry.ts')
  check('a lost local connection is re-marked with why and the retry verb', registrySrc.includes('error: `the server closed its connection — a local server is not restarted on its own; /mcp reconnect ${name} starts it again`'))
  const menuSrc = read('src/components/mcp/MCPRemoteServerMenu.tsx')
  check('a cleared sign-in names itself on the failed row', menuSrc.includes('error: `signed out of ${server.name} — /mcp reconnect ${server.name} signs in again`'))
  const { execSync } = await import('node:child_process')
  const files = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx'", { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).filter(file => existsSync(join(ROOT, file)))
  const bareMints: string[] = []
  for (const file of files) {
    const src = readFileSync(join(ROOT, file), 'utf8')
    const re = /\{[^{}]*type: 'failed'(?: as const)?[^{}]*\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const literal = m[0]
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
