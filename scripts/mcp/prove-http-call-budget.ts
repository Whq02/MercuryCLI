#!/usr/bin/env bun
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const rpc = (method: string, params: unknown = {}): string => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })

const client = await import(join(SRC, 'services/mcp/client.ts'))

console.log('L1 the budget oracle')
{
  process.env.MERCURY_MCP_TOOL_TIMEOUT_MS = '444000'
  const budget = client.mcpRequestBudgetMs as ((body: unknown) => number) | undefined
  if (budget === undefined) {
    t('the method-scoped budget oracle exists', false, 'mcpRequestBudgetMs is absent (pre-fix tree)')
  } else {
    t('tools/call rides the tool timeout (MERCURY_MCP_TOOL_TIMEOUT_MS respected)', budget(rpc('tools/call', { name: 'x', arguments: {} })) === 444_000, String(budget(rpc('tools/call'))))
    t('initialize keeps the short budget', budget(rpc('initialize')) === 60_000)
    t('tools/list keeps the short budget', budget(rpc('tools/list')) === 60_000)
    t('a batch body reads its first entry', budget(`[${rpc('tools/call')},${rpc('tools/list')}]`) === 444_000)
    t('a malformed body keeps the short budget', budget('{not json') === 60_000)
    t('a non-string body keeps the short budget', budget(undefined) === 60_000)
    t('a method buried past the head is still found (full-parse fallback)', budget(JSON.stringify({ jsonrpc: '2.0', id: 1, params: { pad: 'x'.repeat(4000) }, method: 'tools/call' })) === 444_000)
  }
  delete process.env.MERCURY_MCP_TOOL_TIMEOUT_MS
}

console.log('L2 the wire at small scales')
{
  process.env.MERCURY_MCP_TOOL_TIMEOUT_MS = '300'
  const never: (input: unknown, init?: { signal?: AbortSignal }) => Promise<Response> = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })
  const wrapped = client.wrapFetchWithTimeout(never as never) as (input: string, init?: Record<string, unknown>) => Promise<Response>

  const call = wrapped('https://mcp.example/rpc', { method: 'POST', body: rpc('tools/call', { name: 'x' }) })
  delete process.env.MERCURY_MCP_TOOL_TIMEOUT_MS
  const callVerdict = await Promise.race([
    call.then(
      () => 'resolved',
      (e: unknown) => `aborted:${(e as { name?: string })?.name}`,
    ),
    new Promise<string>(resolve => setTimeout(() => resolve('still-pending'), 1_200)),
  ])
  t('a never-answering tools/call aborts at the tool timeout (~300ms), named TimeoutError', callVerdict === 'aborted:TimeoutError', callVerdict)

  const init = wrapped('https://mcp.example/rpc', { method: 'POST', body: rpc('initialize') })
  const initVerdict = await Promise.race([
    init.then(
      () => 'resolved',
      (e: unknown) => `aborted:${(e as { name?: string })?.name}`,
    ),
    new Promise<string>(resolve => setTimeout(() => resolve('still-pending'), 900)),
  ])
  t('an initialize POST under the same env is still alive well past 300ms (60s budget untouched)', initVerdict === 'still-pending', initVerdict)
  init.catch(() => {})
}

console.log('L3 GET stays exempt')
{
  const client = await import(join(SRC, 'services/mcp/client.ts'))
  let sawSignal: unknown = 'unset'
  const base = async (_input: unknown, init?: { signal?: AbortSignal }): Promise<Response> => {
    sawSignal = init?.signal ?? null
    return new Response('ok')
  }
  const wrapped = client.wrapFetchWithTimeout(base as never) as (input: string, init?: Record<string, unknown>) => Promise<Response>
  await wrapped('https://mcp.example/stream', { method: 'GET' })
  t('a GET rides through with no imposed budget signal', sawSignal === null || sawSignal === undefined, String(sawSignal))
}

console.log(failures === 0 ? 'HTTP CALL BUDGET: ALL PASS' : 'HTTP CALL BUDGET: RED')
process.exit(failures)
