#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-mcp-stderr-flush.ts
//  PROOF for: the MCP stdio server stderr handler appended every line into
//  a string toward a 64MB cap, flushed/reset only ONCE at connect and detached
//  only on disconnect → a noisy long-lived server grew the buffer monotonically
//  (up to 64MB/server of never-surfaced dead retention). The fix flushes+resets the
//  buffer to the MCP error log once it crosses a 1MB threshold.
//
//  client.ts is unloadable under bun-run (heavy MCP graph), so this locks the
//  wiring by source-text + mirrors the (pure) flush-on-threshold handler.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-mcp-stderr-flush.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const client = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'mcp', 'client.ts'), 'utf-8')

console.log('============================================================')
console.log(' mcp stderr flush — bounded buffer, surfaced not held (HB-0123)')
console.log('============================================================')

section('source: the handler flushes+resets on a threshold (not a 64MB hold)')
// Source pins over client.ts: the
// threshold is STDERR_FLUSH_BYTES and the buffer is stderrBuffer, flushed to the
// MCP error log once it crosses 1 MiB and reset. Same law, Mercury spellings.
check('a 1MB flush threshold is defined', /const STDERR_FLUSH_BYTES = 1024 \* 1024/.test(client))
check('the handler flushes + resets once the buffer crosses the threshold', /if \(stderrBuffer\.length >=? STDERR_FLUSH_BYTES\)[\s\S]{0,90}logMCPError\(name, `stderr: \$\{stderrBuffer\}`\)[\s\S]{0,40}stderrBuffer = ''/.test(client))
check('the old monotonic-to-64MB cap-and-hold is gone', !/if \(stderr(?:Output|Buffer)\.length < 64 \* 1024 \* 1024\)/.test(client))

section('behavioural mirror: memory stays bounded + stderr is surfaced')
// Mirror of the shipped handler.
const THRESHOLD = 1024 * 1024
const makeHandler = () => {
  let buf = ''
  const logged: number[] = []
  const onData = (chunk: string): void => {
    buf += chunk
    if (buf.length >= THRESHOLD) {
      logged.push(buf.length) // "surface to the MCP error log"
      buf = ''
    }
  }
  return { onData, peek: () => buf, logged }
}
const h = makeHandler()
let maxSeen = 0
// Simulate a noisy long-lived server: 200MB of stderr in 64KB chunks.
const chunk = 'x'.repeat(64 * 1024)
for (let i = 0; i < (200 * 1024 * 1024) / chunk.length; i++) {
  h.onData(chunk)
  maxSeen = Math.max(maxSeen, h.peek().length)
}
check('the live buffer NEVER exceeds threshold + one chunk (bounded, not 64MB+)', maxSeen < THRESHOLD + chunk.length, `maxSeen=${maxSeen}`)
check('the stderr WAS surfaced (flushed many times, not held dead)', h.logged.length > 100, `${h.logged.length} flushes`)
check('after 200MB of input the retained buffer is tiny', h.peek().length < THRESHOLD)
// A quiet server (under threshold) retains its stderr for the connect/disconnect log.
const q = makeHandler()
q.onData('a startup warning\n')
check('a sub-threshold buffer is retained (still surfaced at connect/disconnect)', q.peek().length > 0 && q.logged.length === 0)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MCP-STDERR-FLUSH PROOFS PASS')
else console.log(`❌ ${failures} MCP-STDERR-FLUSH PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
