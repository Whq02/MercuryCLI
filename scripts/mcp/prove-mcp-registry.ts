#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-mcp-registry.ts — the owned MCP server registry.
//
//  Drives McpServerRegistry hermetically through injected ports (controllable
//  connect deferreds · virtual backoff clock · in-memory disk store) and pins
//  the ratified Phase 4 contract:
//    • DUPLICATE CONNECTS — two plain connect intents single-flight onto one
//      port call; a queued duplicate never re-runs the impl.
//    • AUTH RACES — needs-auth applies; a manual reconnect supersedes an
//      in-flight attempt (the older completion is DISCARDED, never applied).
//    • STALE GENERATIONS — a toggle-disable mid-connect wins; the slow
//      connected completion is dropped with an explicit stale-drop event.
//    • PARTIAL FAILURE — one failing server never blocks or corrupts others.
//    • THE RETRY OWNER — connectionLost starts ONE backoff loop (1s→2s→4s…,
//      capped, disk-disabled checked between attempts); a second signal while
//      the loop is active is a no-op; stdio/sdk go terminal-failed instead.
//    • SHUTDOWN — aborts backoff sleeps, invalidates every slot, emits
//      nothing further.
//    • EVENT LAWS — seq strictly increasing, per-server generation monotonic,
//      snapshot() equals the last emitted connection per server.
//
//  Run:  ~/.bun/bin/bun run scripts/mcp/prove-mcp-registry.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mcp-registry-'))

const {
  McpServerRegistry,
  MAX_RECONNECT_ATTEMPTS,
} = await import('../../src/services/mcp/registry/serverRegistry.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — registry proof exceeded 30s (a deferred never resolved?)')
  process.exit(1)
}, 30_000)
guard.unref?.()

// ── fake ports ──────────────────────────────────────────────────────────────
type Deferred = {
  resolve: (o: unknown) => void
  name: string
}
function makeHarness(opts: { autoResolve?: (name: string, call: number) => unknown } = {}) {
  const connectCalls: string[] = []
  const deferreds: Deferred[] = []
  const sleeps: Array<{ ms: number; resolve: () => void; aborted: () => boolean }> = []
  const disk = new Set<string>() // disabled names
  const perName = new Map<string, number>()
  const ports = {
    connect: (name: string) => {
      const call = (perName.get(name) ?? 0) + 1
      perName.set(name, call)
      connectCalls.push(name)
      if (opts.autoResolve) {
        return Promise.resolve(opts.autoResolve(name, call))
      }
      return new Promise(resolve => {
        deferreds.push({ resolve: resolve as (o: unknown) => void, name })
      })
    },
    connectMany: async (
      configs: Record<string, unknown>,
      onSettle: (o: unknown) => void,
    ) => {
      // The fake mass path settles every server through the per-name connect
      // deferred/auto-resolve machinery, concurrently (like pMap).
      await Promise.all(
        Object.keys(configs).map(async name => {
          const outcome = await ports.connect(name)
          onSettle(outcome)
        }),
      )
    },
    disconnect: async () => {},
    isDisabledOnDisk: (name: string) => disk.has(name),
    setEnabledOnDisk: (name: string, enabled: boolean) => {
      if (enabled) disk.delete(name)
      else disk.add(name)
    },
    sleep: (ms: number, signal: AbortSignal) =>
      new Promise<void>(resolve => {
        const entry = { ms, resolve, aborted: () => signal.aborted }
        sleeps.push(entry)
        signal.addEventListener('abort', () => resolve(), { once: true })
      }),
  }
  return { ports, connectCalls, deferreds, sleeps, disk }
}

const cfg = (type = 'http') => ({ type, url: 'http://127.0.0.1:1/x', scope: 'project' }) as never
const connected = (name: string) => ({
  client: { name, type: 'connected', client: {}, capabilities: {}, config: cfg(), cleanup: async () => {} },
  tools: [{ name: `mcp__${name}__t` }],
  commands: [],
})
const failed = (name: string) => ({ client: { name, type: 'failed', config: cfg() }, tools: [], commands: [] })
const needsAuth = (name: string) => ({ client: { name, type: 'needs-auth', config: cfg() }, tools: [], commands: [] })
const tick = () => new Promise<void>(r => setTimeout(r, 0))
const ticks = async (n: number) => { for (let i = 0; i < n; i++) await tick() }

type Ev = { seq: number; name: string; generation: number; cause: string; connection: { type: string } }
function tapEvents(reg: InstanceType<typeof McpServerRegistry>): Ev[] {
  const events: Ev[] = []
  reg.subscribe(e => events.push(e as never))
  return events
}

// ---------------------------------------------------------------------------
section('duplicate connects — single-flight onto ONE port call')
{
  const h = makeHarness()
  const reg = new McpServerRegistry(h.ports as never)
  const events = tapEvents(reg)
  const p1 = reg.connect('srv', cfg())
  const p2 = reg.connect('srv', cfg())
  check('second plain connect returns the SAME op (no second enqueue)', p1 === p2)
  await ticks(2)
  check('one port call while both intents pend', h.connectCalls.length === 1, j(h.connectCalls))
  h.deferreds[0]!.resolve(connected('srv'))
  await Promise.all([p1, p2])
  check('final phase connected', reg.get('srv')?.type === 'connected')
  check('exactly one settled connect event with tools', events.filter(e => e.cause === 'connect' && (e as never as { tools?: unknown[] }).tools).length === 1, j(events))
  // A LATER connect after settlement coalesces on the connected phase — no new port call.
  await reg.connect('srv', cfg())
  check('post-settlement duplicate connect is a no-op (still one port call)', h.connectCalls.length === 1, j(h.connectCalls))
}

// ---------------------------------------------------------------------------
section('auth races — needs-auth applies; manual reconnect supersedes in-flight')
{
  const h = makeHarness()
  const reg = new McpServerRegistry(h.ports as never)
  const events = tapEvents(reg)
  const p1 = reg.connect('auth', cfg())
  await ticks(2)
  // While the first attempt is in flight, the user completes OAuth and hits
  // manual reconnect — the manual intent supersedes.
  const p2 = reg.connect('auth', cfg(), 'reconnect-manual')
  h.deferreds[0]!.resolve(needsAuth('auth')) // the OLD attempt settles LATE
  await p1
  check('stale first completion DISCARDED (never applied)', reg.get('auth')?.type !== 'needs-auth', j(reg.get('auth')))
  check('a stale-drop event was emitted', events.some(e => e.cause === 'stale-drop'))
  await ticks(2)
  h.deferreds[1]!.resolve(connected('auth'))
  await p2
  check('manual reconnect result applied → connected', reg.get('auth')?.type === 'connected')
  check('two port calls total (old + manual)', h.connectCalls.length === 2, j(h.connectCalls))

  // The plain needs-auth application path (no race): a fresh server settling
  // needs-auth is applied as-is.
  const h2 = makeHarness({ autoResolve: n => needsAuth(n) })
  const reg2 = new McpServerRegistry(h2.ports as never)
  await reg2.connect('auth2', cfg())
  check('un-raced needs-auth applies', reg2.get('auth2')?.type === 'needs-auth')
}

// ---------------------------------------------------------------------------
section('stale generations — toggle-disable mid-connect wins')
{
  const h = makeHarness()
  const reg = new McpServerRegistry(h.ports as never)
  reg.seed({ slow: cfg() })
  const p1 = reg.connect('slow', cfg())
  await ticks(2)
  const pToggle = reg.toggle('slow') // disable while the connect is in flight
  h.deferreds[0]!.resolve(connected('slow')) // the slow connect settles late
  await Promise.all([p1, pToggle])
  check('disable wins — phase disabled', reg.get('slow')?.type === 'disabled', j(reg.get('slow')))
  check('disk store shows disabled', h.disk.has('slow'))
  // Re-enable → fresh connect applies.
  const pEnable = reg.toggle('slow')
  await ticks(2)
  h.deferreds[1]!.resolve(connected('slow'))
  await pEnable
  check('re-enable connects fresh', reg.get('slow')?.type === 'connected')
}

// ---------------------------------------------------------------------------
section('partial failure — one failing server never blocks the others')
{
  const h = makeHarness({
    autoResolve: name => (name === 'bad' ? failed(name) : connected(name)),
  })
  const reg = new McpServerRegistry(h.ports as never)
  await Promise.all([reg.connect('a', cfg()), reg.connect('bad', cfg()), reg.connect('b', cfg())])
  check('a connected', reg.get('a')?.type === 'connected')
  check('b connected', reg.get('b')?.type === 'connected')
  check('bad failed', reg.get('bad')?.type === 'failed')
}

// ---------------------------------------------------------------------------
section('the retry owner — one backoff loop, exponential, disk-checked')
{
  const h = makeHarness()
  const reg = new McpServerRegistry(h.ports as never)
  reg.seed({ r: cfg('sse') })
  const p1 = reg.connect('r', cfg('sse'))
  await ticks(2)
  h.deferreds[0]!.resolve(connected('r'))
  await p1

  const loop = reg.connectionLost('r')
  const second = reg.connectionLost('r') // while the loop is active
  await ticks(2)
  check('one port call so far in the loop (second signal was a no-op)', h.connectCalls.length === 2, j(h.connectCalls))
  check('pending carries attempt counters', (reg.get('r') as { reconnectAttempt?: number })?.reconnectAttempt === 1)
  // attempt 1 fails → backoff 1000ms
  h.deferreds[1]!.resolve(failed('r'))
  await ticks(4)
  check('backoff #1 is 1000ms', h.sleeps[0]?.ms === 1000, j(h.sleeps.map(s => s.ms)))
  h.sleeps[0]!.resolve()
  await ticks(4)
  // attempt 2 fails → backoff 2000ms
  h.deferreds[2]!.resolve(failed('r'))
  await ticks(4)
  check('backoff #2 is 2000ms', h.sleeps[1]?.ms === 2000, j(h.sleeps.map(s => s.ms)))
  // Disable on disk mid-loop: the next iteration stops the retry.
  h.disk.add('r')
  h.sleeps[1]!.resolve()
  await Promise.all([loop, second])
  check('disk-disabled mid-loop stops the retry (3 port calls total)', h.connectCalls.length === 3, j(h.connectCalls))

  // Exhaustion path: fresh registry, every attempt fails, virtual clock.
  const h2 = makeHarness({ autoResolve: n => failed(n) })
  // auto-resolve sleeps immediately for the exhaustion run
  h2.ports.sleep = async () => {}
  const reg2 = new McpServerRegistry(h2.ports as never)
  reg2.seed({ x: cfg('http') })
  const c = reg2.connect('x', cfg('http'))
  await c
  await reg2.connectionLost('x')
  check(
    `exhaustion after ${MAX_RECONNECT_ATTEMPTS} attempts → failed`,
    reg2.get('x')?.type === 'failed' && h2.connectCalls.length === 1 + MAX_RECONNECT_ATTEMPTS,
    j({ phase: reg2.get('x')?.type, calls: h2.connectCalls.length }),
  )

  // stdio/sdk: terminal failed, no loop.
  const h3 = makeHarness({ autoResolve: n => connected(n) })
  const reg3 = new McpServerRegistry(h3.ports as never)
  reg3.seed({ s: cfg('stdio') })
  await reg3.connect('s', cfg('stdio'))
  await reg3.connectionLost('s')
  check('stdio connection-lost → terminal failed (no retry loop)', reg3.get('s')?.type === 'failed' && h3.sleeps.length === 0)
}

// ---------------------------------------------------------------------------
section('shutdown — aborts sleeps, invalidates slots, emits nothing further')
{
  const h = makeHarness()
  const reg = new McpServerRegistry(h.ports as never)
  const events = tapEvents(reg)
  reg.seed({ z: cfg('sse') })
  const p = reg.connect('z', cfg('sse'))
  await ticks(2)
  h.deferreds[0]!.resolve(connected('z'))
  await p
  void reg.connectionLost('z')
  await ticks(2)
  h.deferreds[1]!.resolve(failed('z'))
  await ticks(4)
  check('backoff sleep armed before shutdown', h.sleeps.length === 1)
  const before = events.length
  reg.shutdown()
  h.sleeps[0]!.resolve()
  await ticks(6)
  check('no events after shutdown', events.length === before, j(events.slice(before)))
  check('no further port calls after shutdown', h.connectCalls.length === 2, j(h.connectCalls))
}

// ---------------------------------------------------------------------------
section('connectAll — the batch path routes settles through generation checks')
{
  const h = makeHarness()
  const reg = new McpServerRegistry(h.ports as never)
  const events = tapEvents(reg)
  const batch = reg.connectAll({ m1: cfg(), m2: cfg() })
  await ticks(2)
  check('batch launched both connects', h.connectCalls.length === 2, j(h.connectCalls))
  // A toggle-disable lands for m2 while the batch is in flight.
  const pToggle = reg.toggle('m2')
  h.deferreds.find(d => d.name === 'm1')!.resolve(connected('m1'))
  h.deferreds.find(d => d.name === 'm2')!.resolve(connected('m2'))
  await Promise.all([batch, pToggle])
  check('m1 batch settle applied', reg.get('m1')?.type === 'connected')
  check('m2 batch settle DISCARDED (toggle won)', reg.get('m2')?.type === 'disabled', j(reg.get('m2')))
  check('m2 stale-drop emitted', events.some(e => e.name === 'm2' && e.cause === 'stale-drop'))
  // The outcome-returning manual path: the UI reads result.client.type.
  const h2 = makeHarness({ autoResolve: n => connected(n) })
  const reg2 = new McpServerRegistry(h2.ports as never)
  reg2.seed({ o: cfg() })
  const outcome = await reg2.connect('o', cfg(), 'reconnect-manual')
  check('manual connect resolves with the applied outcome', (outcome as { client?: { type?: string } })?.client?.type === 'connected', j(outcome))
}

// ---------------------------------------------------------------------------
section('event laws — seq increasing, generation monotonic, snapshot coherent')
{
  const h = makeHarness({ autoResolve: (n, call) => (call === 1 ? failed(n) : connected(n)) })
  h.ports.sleep = async () => {}
  const reg = new McpServerRegistry(h.ports as never)
  const events = tapEvents(reg)
  reg.seed({ e1: cfg(), e2: cfg() })
  await Promise.all([reg.connect('e1', cfg()), reg.connect('e2', cfg())])
  await reg.connect('e1', cfg(), 'reconnect-manual')
  reg.applyServerUpdate('e1', { tools: [] })

  const seqs = events.map(e => e.seq)
  check('seq strictly increasing', seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), j(seqs))
  for (const name of ['e1', 'e2']) {
    const gens = events.filter(e => e.name === name).map(e => e.generation)
    check(`${name} generation monotonic (non-decreasing)`, gens.every((g, i) => i === 0 || g >= gens[i - 1]!), j(gens))
  }
  const last = new Map<string, unknown>()
  for (const e of events) last.set(e.name, e.connection)
  const snap = reg.snapshot()
  check(
    'snapshot equals last emitted connection per server',
    snap.every(c => j(last.get((c as { name: string }).name)) === j(c)),
    j({ snap, last: [...last.entries()] }),
  )
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ MCP REGISTRY GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} MCP REGISTRY FAILURE(S)`)
process.exit(1)
