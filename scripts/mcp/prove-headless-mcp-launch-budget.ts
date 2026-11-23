#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-launch-budget-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
process.env.MERCURY_MCP_TIMEOUT_MS = '1500'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const client = await import(join(SRC, 'integrations/mcp/client.ts'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const FIXTURE = join(import.meta.dir, '_fixture-stdio-server.mjs')
const stdioConfig = { type: 'stdio' as const, command: process.execPath, args: [FIXTURE], scope: 'local' as const }

section('§1 THE LAUNCH BUDGET')
{
  const withBudget = client.withMcpLaunchBudget as ((work: Promise<unknown>, ms: number) => Promise<string>) | undefined
  const budgetMs = client.mcpLaunchBudgetMs as (() => number) | undefined
  check('the budget helper is exported from the MCP owner', typeof withBudget === 'function', 'export withMcpLaunchBudget from src/integrations/mcp/client.ts (defined in src/integrations/mcp/client/limits.ts)')
  check('the budget reads the connect deadline (MERCURY_MCP_TIMEOUT_MS, live) plus the spawn grace, so a server that never answers is told inside it', budgetMs?.() === 1500 + client.MCP_LAUNCH_SPAWN_GRACE_MS && client.MCP_LAUNCH_SPAWN_GRACE_MS === 1_000, String(budgetMs?.()) + ' — mcpLaunchBudgetMs() in src/integrations/mcp/client/limits.ts must return connectTimeoutMs() (MERCURY_MCP_TIMEOUT_MS) plus MCP_LAUNCH_SPAWN_GRACE_MS (1000)')
  if (withBudget) {
    const t0 = Date.now()
    const verdict = await withBudget(new Promise(() => {}), 120)
    const took = Date.now() - t0
    check("a batch still settling at the budget answers 'timeout' — the run proceeds", verdict === 'timeout' && took >= 100 && took < 1_000, `${verdict} after ${took}ms — withMcpLaunchBudget() in src/integrations/mcp/client/limits.ts must answer 'timeout' when the work is still pending at the budget`)
    const t1 = Date.now()
    const settled = await withBudget(Promise.resolve(), 5_000)
    check("a settled batch answers 'settled' at once (the timer never holds the run)", settled === 'settled' && Date.now() - t1 < 500, `${settled} after ${Date.now() - t1}ms — withMcpLaunchBudget() in src/integrations/mcp/client/limits.ts must answer 'settled' as soon as the work settles`)
    const rejected = await withBudget(Promise.reject(new Error('boom')), 5_000)
    check("a rejecting batch still answers 'settled' — the budget never throws", rejected === 'settled', rejected + ' — withMcpLaunchBudget() in src/integrations/mcp/client/limits.ts must map a rejection to settled, never throw')
  }
}

section('§2 THE DISCOVERY DEADLINE, END TO END')
{
  process.env.MCP_FIXTURE_STALL_TOOLS_LIST = '1'
  const t0 = Date.now()
  const connection = (await client.connectToServer('stall_srv', stdioConfig)) as { type: string }
  check('the stalled server connects (the handshake completes)', connection.type === 'connected', connection.type + ' — connectToServer() in src/integrations/mcp/client.ts did not connect the stdio fixture scripts/mcp/_fixture-stdio-server.mjs')
  const tools = (await client.fetchToolsForClient(connection)) as unknown[]
  const took = Date.now() - t0
  check('discovery settles within the deadline window, never the SDK 60s default', took < 6_000, `${took}ms — the tools/list request in src/integrations/mcp/client/toolList.ts must carry connectTimeoutMs() from src/integrations/mcp/client/limits.ts`)
  check('the stalled discovery answers no tools', Array.isArray(tools) && tools.length === 0, String(tools.length) + ' — fetchToolsForClient() in src/integrations/mcp/client.ts must return [] when tools/list fails')
  const getFailure = client.getToolDiscoveryFailure as ((name: string) => { message: string } | null) | undefined
  const failure = getFailure?.('stall_srv') ?? null
  check('the failure is recorded with its reason (the discovery ladder retries it later)', failure !== null, JSON.stringify(failure) + ' — the catch in fetchToolsForClient() (src/integrations/mcp/client.ts) must record the failure in toolDiscoveryFailures')
  delete process.env.MCP_FIXTURE_STALL_TOOLS_LIST
}

section('§3 THE WIRE OPTION')
{
  const seen: Record<string, number | undefined> = {}
  const scripted = {
    type: 'connected',
    name: 'scripted_deadline',
    capabilities: { tools: true, prompts: true, resources: true },
    config: { type: 'stdio', command: 'scripted' },
    client: {
      request: async (req: { method: string }, options?: { timeout?: number }) => {
        seen[req.method] = options?.timeout
        return { tools: [], prompts: [], resources: [] }
      },
    },
  }
  await client.fetchToolsForClient(scripted as never)
  await client.fetchCommandsForClient(scripted as never)
  await client.fetchResourcesForClient(scripted as never)
  check('tools/list carries the connect deadline', seen['tools/list'] === 1500, JSON.stringify(seen) + ' — pass { timeout: connectTimeoutMs() } on the tools/list request in src/integrations/mcp/client/toolList.ts')
  check('prompts/list carries it', seen['prompts/list'] === 1500, JSON.stringify(seen) + ' — pass { timeout: connectTimeoutMs() } on the prompts/list request in fetchCommandsForClient() (src/integrations/mcp/client.ts)')
  check('resources/list carries it', seen['resources/list'] === 1500, JSON.stringify(seen) + ' — pass { timeout: connectTimeoutMs() } on the resources/list request in fetchResourcesForClient() (src/integrations/mcp/client.ts)')
}


rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-headless-mcp-launch-budget: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-headless-mcp-launch-budget: all green')
process.exit(0)
