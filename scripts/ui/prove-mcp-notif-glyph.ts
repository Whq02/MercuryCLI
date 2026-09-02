#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-mcp-notif-glyph.ts
//  PROOF for: the 4 live MCP footer notifs + the LSP-failed notif
//  signaled severity by COLOR ONLY (inner <Text color=error|warning>, no glyph),
//  rendered through Notifications.tsx:293 (<Text wrap="truncate">) which adds
//  none → under NO_COLOR/colorblind a failed server read like a benign dim hint,
//  and error was indistinguishable from warning. Fix (mirrors the shipped
// lead the error spans with GLYPH.fail (✕) and the warning spans with
//  GLYPH.warn (▲). Render-verify is in render-mcp-notif-a11y.tsx (UI_RENDER=1).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-mcp-notif-glyph.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const mcp = readFileSync(join(root, 'src', 'hooks', 'notifs', 'useMcpConnectivityStatus.tsx'), 'utf-8')
const lsp = readFileSync(join(root, 'src', 'hooks', 'notifs', 'useLspInitializationNotification.tsx'), 'utf-8')

console.log('============================================================')
console.log(' MCP/LSP notif severity glyphs — a11y (HB-0181)')
console.log('============================================================')

section('source: each severity-colored span LEADS with its glyph (not the tail)')
const IMP = /import \{ GLYPH \} from '\.\.\/\.\.\/components\/mercury-ui\/glyphs\.js'/
check('useMcpConnectivityStatus imports GLYPH', IMP.test(mcp))
check('useLspInitializationNotification imports GLYPH', IMP.test(lsp))
// the glyph must lead the COLORED span; the trailing dimColor "· /mcp" span stays bare.
// The glyph is its own tone-colored span at the HEAD of the notice; the count
// and the dim "— /mcp for details" tail follow it bare.
check('mcp-failed: error span leads with GLYPH.fail', /<Text color="error">\{GLYPH\.fail\}<\/Text> \{failedLocal\.length\} MCP/.test(mcp))
check('mcp-claudeai-failed: error span leads with GLYPH.fail', /<Text color="error">\{GLYPH\.fail\}<\/Text> \{failedClaudeAi\.length\}/.test(mcp))
check('mcp-needs-auth: warning span leads with GLYPH.warn', /<Text color="warning">\{GLYPH\.warn\}<\/Text> \{needsAuthLocal\.length\}/.test(mcp))
check('mcp-claudeai-needs-auth: warning span leads with GLYPH.warn', /<Text color="warning">\{GLYPH\.warn\}<\/Text> \{needsAuthClaudeAi\.length\}/.test(mcp))
check('lsp-error: error span leads with GLYPH.fail', /<Text color="error">\{GLYPH\.fail\}<\/Text> LSP failed for\{' '\}/.test(lsp))
check('the glyph is NOT placed on the trailing dimColor "— /mcp" span', !/<Text dimColor>[^<]*\{GLYPH\./.test(mcp))

section('glyphs: fail=✕ and warn=▲ are DISTINCT (so error≠warning color-stripped) + width-1')
const glyphs = (await import(join(root, 'src', 'components', 'mercury-ui', 'glyphs.ts'))) as {
  GLYPH: Record<string, string>
  displayWidth: (s: string) => number
}
check('GLYPH.fail = ✕ (error tone)', glyphs.GLYPH.fail === '✕')
check('GLYPH.warn = ▲ (warning tone)', glyphs.GLYPH.warn === '▲')
check('the two glyphs DIFFER (error vs warning distinguishable with color stripped)', glyphs.GLYPH.fail !== glyphs.GLYPH.warn)
check('GLYPH.fail is display-width 1 (no EAW column drift)', glyphs.displayWidth(glyphs.GLYPH.fail!) === 1)
check('GLYPH.warn is display-width 1', glyphs.displayWidth(glyphs.GLYPH.warn!) === 1)

section('slot-safety: the inline-glyph add did not touch the _c cache (HB-0178 pattern)')
// Both files are _c-memoized; the edit adds a GLYPH ref inside the JSX leaf, not
// a cache slot. Phase 3b de-compiled both hooks to plain code — the invariant
// is now the ABSENCE of any _c cache (nothing left to hand-patch).
check('useMcpConnectivityStatus is de-compiled (no _c allocs)', (mcp.match(/= _c\(\d+\)/g) ?? []).length === 0)
check('useLspInitializationNotification is de-compiled (no _c allocs)', (lsp.match(/= _c\(\d+\)/g) ?? []).length === 0)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0181 — MCP/LSP notif severity glyphs (a11y) proven')
  process.exit(0)
} else {
  console.log(` ❌ HB-0181 — ${failures} check(s) failed`)
  process.exit(1)
}
