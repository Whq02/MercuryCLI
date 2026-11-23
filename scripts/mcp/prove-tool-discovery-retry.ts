#!/usr/bin/env bun
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const client = await import(join(SRC, 'integrations/mcp/client.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const DISCOVERY_WHERE = 'fix fetchToolsForClient and getToolDiscoveryFailure in src/integrations/mcp/client.ts (the catch records toolDiscoveryFailures, the wrapper evicts the memo once nextRetryAt has passed)'

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

console.log('L1 a failed discovery is recorded and the immediate re-read stays memoized')
const srv = scriptedServer('scripted-srv')
{
  const first = await client.fetchToolsForClient(srv.connection as never)
  t('the failed discovery answers empty (unchanged surface)', Array.isArray(first) && first.length === 0, `got ${JSON.stringify(first)}; ${DISCOVERY_WHERE}`)
  t('the failure is recorded with its reason', getFailure !== undefined && getFailure('scripted-srv')?.message.includes('exploded') === true, getFailure ? JSON.stringify(getFailure('scripted-srv')) + `; ${DISCOVERY_WHERE}` : `getToolDiscoveryFailure is absent; export it from src/integrations/mcp/client.ts`)
  const second = await client.fetchToolsForClient(srv.connection as never)
  t('an immediate re-read stays memoized (no thundering retry)', second.length === 0 && srv.calls() === 1, `request calls=${srv.calls()}; ${DISCOVERY_WHERE}`)
}

console.log('L2 the backoff elapses, the next read retries, a healed server serves its tools')
{
  srv.heal()
  const realNow = Date.now
  try {
    const base = realNow()
    Date.now = () => base + 31_000
    const third = await client.fetchToolsForClient(srv.connection as never)
    t('the read after the backoff RETRIES (the poisoned entry evicted)', srv.calls() === 2, `request calls=${srv.calls()}; ${DISCOVERY_WHERE}`)
    t('the healed server contributes its tools', third.length === 1, `tools=${third.length}; ${DISCOVERY_WHERE}`)
  } finally {
    Date.now = realNow
  }
  t('the failure record clears on success', getFailure === undefined || getFailure('scripted-srv') === null, getFailure ? JSON.stringify(getFailure('scripted-srv')) + `; the success path must call toolDiscoveryFailures.delete in src/integrations/mcp/client.ts` : '')
}

console.log('L3 controls — a healthy first discovery records nothing; explicit invalidation refetches at once')
{
  const healthy = scriptedServer('healthy-srv')
  healthy.heal()
  const tools = await client.fetchToolsForClient(healthy.connection as never)
  t('a healthy discovery serves tools and records no failure', tools.length === 1 && (getFailure === undefined || getFailure('healthy-srv') === null), `tools=${tools.length}; ${DISCOVERY_WHERE}`)
  client.fetchToolsForClient.cache.delete('healthy-srv')
  await client.fetchToolsForClient(healthy.connection as never)
  t('the listChanged/onclose invalidation road still refetches at once', healthy.calls() === 2, `request calls=${healthy.calls()}; fetchToolsForClient.cache must stay the memo cache in src/integrations/mcp/client.ts`)
}

console.log(failures === 0 ? 'TOOL DISCOVERY RETRY: ALL PASS' : 'TOOL DISCOVERY RETRY: RED')
process.exit(failures)
