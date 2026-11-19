#!/usr/bin/env bun
import { join } from 'node:path'

const ROOT = process.cwd()

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
}

if (failures > 0) {
  console.log(`\n ❌ mcp-failure-surfaces — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ mcp-failure-surfaces — the card, the mid-call sentences, every failed re-mark with its reason, the dial window')
