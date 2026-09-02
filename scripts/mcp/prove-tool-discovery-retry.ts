#!/usr/bin/env bun
// ============================================================================
//  prove-tool-discovery-retry — one failed tools/list is never memoized as
//  an empty tool set for the life of the connection (release-hardening
//  audit rank 36).
//
//  The gap: fetchToolsForClient was a lodash memoize keyed on the client
//  name whose catch returned [] — and memoize stores the promise, so the
//  empty answer was cached forever. A server that completed the MCP
//  handshake but whose first tools/list failed (the SDK's 60s default
//  exceeded, a protocol error, a stdio server doing heavy imports between
//  initialize and tools/list) sat in the roster as connected while
//  contributing zero tools, with no error row, no reason, and nothing ever
//  retrying; none of the three invalidation sites fires for a still-open
//  connection whose server does not advertise listChanged. The only
//  recovery was the user noticing and reconnecting by hand.
//
//   L1 the failure is RECORDED (getToolDiscoveryFailure names the reason)
//      and the immediate re-read stays memoized — no thundering retry
//   L2 once the backoff elapses the next read retries and a now-healthy
//      server's tools arrive; the failure record clears
//   L3 controls: a successful first discovery records nothing; an explicit
//      cache invalidation (the listChanged/onclose road) refetches at once
//   L4 the roster rows read the reason (structural: both server menus)
//
//  Driven with a scripted connected client whose request fails then heals;
//  the backoff clock rides a patched Date.now (restored). PROVE_SRC names
//  another checkout's src (the A/B control: L1's record, L2 and L4 read
//  red there).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const client = await import(join(SRC, 'services/mcp/client.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

function scriptedServer(name: string): { connection: Record<string, unknown>; calls: () => number; heal: () => void } {
  let calls = 0
  let healthy = false
  const connection = {
    type: 'connected',
    name,
    capabilities: { tools: true },
    config: { type: 'stdio', command: 'scripted' },
    client: {
      request: async () => {
        calls++
        if (!healthy) throw new Error('tools/list exploded after the handshake')
        return { tools: [{ name: 'alpha', description: 'a tool', inputSchema: { type: 'object', properties: {} } }] }
      },
    },
  }
  return { connection, calls: () => calls, heal: () => { healthy = true } }
}

const getFailure = client.getToolDiscoveryFailure as ((name: string) => { message: string } | null) | undefined

// ── L1 ─────────────────────────────────────────────────────────────────────
console.log('L1 a failed discovery is recorded and the immediate re-read stays memoized')
const srv = scriptedServer('scripted-srv')
{
  const first = await client.fetchToolsForClient(srv.connection as never)
  t('the failed discovery answers empty (unchanged surface)', Array.isArray(first) && first.length === 0)
  t('the failure is recorded with its reason', getFailure !== undefined && getFailure('scripted-srv')?.message.includes('exploded') === true, getFailure ? JSON.stringify(getFailure('scripted-srv')) : 'getToolDiscoveryFailure is absent')
  const second = await client.fetchToolsForClient(srv.connection as never)
  t('an immediate re-read stays memoized (no thundering retry)', second.length === 0 && srv.calls() === 1, `request calls=${srv.calls()}`)
}

// ── L2 ─────────────────────────────────────────────────────────────────────
console.log('L2 the backoff elapses, the next read retries, a healed server serves its tools')
{
  srv.heal()
  const realNow = Date.now
  try {
    const base = realNow()
    Date.now = () => base + 31_000 // past the 30s first-attempt backoff
    const third = await client.fetchToolsForClient(srv.connection as never)
    t('the read after the backoff RETRIES (the poisoned entry evicted)', srv.calls() === 2, `request calls=${srv.calls()}`)
    t('the healed server contributes its tools', third.length === 1, `tools=${third.length}`)
  } finally {
    Date.now = realNow
  }
  t('the failure record clears on success', getFailure === undefined || getFailure('scripted-srv') === null, getFailure ? JSON.stringify(getFailure('scripted-srv')) : '')
}

// ── L3 ─────────────────────────────────────────────────────────────────────
console.log('L3 controls — a healthy first discovery records nothing; explicit invalidation refetches at once')
{
  const healthy = scriptedServer('healthy-srv')
  healthy.heal()
  const tools = await client.fetchToolsForClient(healthy.connection as never)
  t('a healthy discovery serves tools and records no failure', tools.length === 1 && (getFailure === undefined || getFailure('healthy-srv') === null))
  client.fetchToolsForClient.cache.delete('healthy-srv')
  await client.fetchToolsForClient(healthy.connection as never)
  t('the listChanged/onclose invalidation road still refetches at once', healthy.calls() === 2, `request calls=${healthy.calls()}`)
}

// ── L4 ─────────────────────────────────────────────────────────────────────
console.log('L4 the roster rows read the reason (structural)')
{
  const stdio = readFileSync(join(SRC, 'components/mcp/MCPStdioServerMenu.tsx'), 'utf8')
  const remote = readFileSync(join(SRC, 'components/mcp/MCPRemoteServerMenu.tsx'), 'utf8')
  t('the stdio server menu names a discovery failure beside a zero tool count', stdio.includes('getToolDiscoveryFailure(server.name)'))
  t('the remote server menu does too', remote.includes('getToolDiscoveryFailure(server.name)'))
}

console.log(failures === 0 ? 'TOOL DISCOVERY RETRY: ALL PASS' : 'TOOL DISCOVERY RETRY: RED')
process.exit(failures)
