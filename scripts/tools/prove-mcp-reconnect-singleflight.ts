#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-mcp-reconnect-singleflight.ts
//  REGRESSION RECORD for: the remote MCP auto-reconnect (onclose →
//  backoff loop) once stacked a CONCURRENT reconnect for the same server when
//  a 2nd onclose fired during the `await reconnectMcpServerImpl` window —
//  both ran clearServerCache+connectToServer, and the loser overwrote the
//  connectToServer memoize entry with no cleanup(), leaking a live remote
//  transport. The first fix was a per-impl single-flight Set in the hook
//  (with a documented residual: manual-vs-auto could still overlap once).
//
//  Since the core-ownership Phase 4 cutover the guarantee is STRUCTURAL: the
//  owned McpServerRegistry (src/services/mcp/registry/serverRegistry.ts)
//  serializes every intent through ONE per-server op chain, the auto-
//  reconnect loop has ONE owner (a second connection-lost signal is a no-op),
//  and GENERATIONS discard superseded completions — which also closes the
//  manual-vs-auto residual the Set-based fix left open.
//
//  This proof pins (a) the source wiring — the hook carries NO reconnect loop
//  of its own; onclose routes into registry.connectionLost — and (b) a live
//  REPLAY of the original hazard against the real registry: two stacked
//  onclose signals while the impl is in flight produce exactly ONE impl call.
//  The full machine contract lives in scripts/mcp/prove-mcp-registry.ts.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-mcp-reconnect-singleflight.ts
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

const ROOT = join(import.meta.dir, '..', '..')
const hook = readFileSync(
  join(ROOT, 'src', 'services', 'mcp', 'useManageMCPConnections.ts'),
  'utf-8',
)
const registrySrc = readFileSync(
  join(ROOT, 'src', 'services', 'mcp', 'registry', 'serverRegistry.ts'),
  'utf-8',
)

console.log('============================================================')
console.log(' mcp reconnect — the registry owns the loop (HB-0128 record)')
console.log('============================================================')

// ───────────────────────────────────────────────────────────────────────────
section('source: the hook owns NO reconnect loop; onclose routes to the registry')
check('the hook has no reconnect backoff loop of its own', !hook.includes('reconnectWithBackoff'))
check('the hook has no single-flight Set (superseded by the op chain)', !hook.includes('reconnectInFlightRef'))
check('the hook has no reconnect timers of its own', !hook.includes('reconnectTimersRef'))
check(
  'onclose routes into registry.connectionLost',
  /client\.client\.onclose = \(\) => \{[\s\S]{0,600}registry\.connectionLost\(client\.name\)/.test(hook),
)
check(
  'the onclose cache-invalidation is preserved ahead of the signal',
  /onclose = \(\) => \{\s*(?:\/\/[^\n]*\n\s*)*clearServerCache\(client\.name, client\.config\)/.test(hook),
)

section('source: the registry serializes intents and owns the retry loop')
check('per-server op chain (the single owner of every await)', registrySrc.includes('slot.chain'))
check('one retry owner (a second signal is a no-op)', registrySrc.includes('retryLoopActive'))
check('generations discard superseded completions', registrySrc.includes("this.stale(slot, gen, 'reconnect completion')"))
check('backoff sleeps are abortable (no orphaned-sleep wedge)', registrySrc.includes('slot.wakeup'))

// ───────────────────────────────────────────────────────────────────────────
section('live replay: two stacked onclose signals ⇒ ONE impl call')
{
  const { McpServerRegistry } = await import(
    '../../src/services/mcp/registry/serverRegistry.ts'
  )
  const connectCalls: string[] = []
  let releaseImpl!: (o: unknown) => void
  const gate = new Promise(res => {
    releaseImpl = res
  })
  const cfg = { type: 'http', url: 'http://127.0.0.1:1/x', scope: 'project' } as never
  const connectedOutcome = {
    client: { name: 'srv', type: 'connected', client: {}, capabilities: {}, config: cfg, cleanup: async () => {} },
    tools: [],
    commands: [],
  }
  let firstCall = true
  const ports = {
    connect: (name: string) => {
      connectCalls.push(name)
      if (firstCall) {
        firstCall = false
        return Promise.resolve(connectedOutcome)
      }
      return gate // the reconnect impl, held in flight
    },
    connectMany: async () => {},
    disconnect: async () => {},
    isDisabledOnDisk: () => false,
    setEnabledOnDisk: () => {},
    sleep: async () => {},
  }
  const reg = new McpServerRegistry(ports as never)
  reg.seed({ srv: cfg })
  await reg.connect('srv', cfg)
  check('setup: connected', reg.get('srv')?.type === 'connected')

  // THE REPLAY: a second onclose lands while the reconnect impl for
  // the first is in flight.
  const loop1 = reg.connectionLost('srv')
  await new Promise(r => setTimeout(r, 0))
  const loop2 = reg.connectionLost('srv')
  await new Promise(r => setTimeout(r, 0))
  check('exactly ONE reconnect impl in flight (no stacked loop)', connectCalls.length === 2, JSON.stringify(connectCalls))
  releaseImpl(connectedOutcome)
  await Promise.all([loop1, loop2])
  check('the surviving loop reconnects', reg.get('srv')?.type === 'connected')
  check('no extra impl calls after settlement', connectCalls.length === 2, JSON.stringify(connectCalls))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0128 — the registry-owned reconnect is single-flight by construction')
  process.exit(0)
} else {
  console.log(` ❌ HB-0128 — ${failures} check(s) failed`)
  process.exit(1)
}
