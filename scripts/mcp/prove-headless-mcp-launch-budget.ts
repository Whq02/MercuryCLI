#!/usr/bin/env bun
// ============================================================================
//  prove-headless-mcp-launch-budget — the print and headless launch waits
//  for its MCP batch only as long as one connect may take, and every
//  discovery request carries that deadline explicitly (release-hardening
//  audit rank 39).
//
//  The gap: the headless batch was awaited whole with no outer bound. A dead
//  stdio server cost the full connect deadline before the first turn; a
//  server that completed the handshake and stalled on tools/list cost the
//  SDK's 60s default per page, up to 50 pages; Promise.all made every other
//  server's tools wait for the slowest. The interactive path never awaited
//  its batch at all — the blocking shape was the print path's alone.
//
//   §1 the launch budget: a batch still settling at the budget answers
//      'timeout' and the run proceeds; a settled batch answers at once; a
//      rejecting batch never throws through the budget
//   §2 the discovery deadline, end to end: a real stdio server that
//      completes the handshake and never answers tools/list settles at the
//      connect deadline, not the SDK default; the failure is recorded
//   §3 the wire option: tools/list, prompts/list and resources/list carry
//      the deadline explicitly
//   §4 the print path binds its batch with the budget and its tool pool
//      reads the store live, so a late server serves the next call
//      (source pins — the print path is not importable without booting)
//
//  Hermetic: scratch config home, MCP_TIMEOUT pinned to 1500ms (the deadline
//  is read live and the budget follows it). PROVE_SRC names another
//  checkout's src (the A/B control: §1, §3 and §4 read red at the pre-fix
//  tree; §2 there waits out the SDK default).
// ============================================================================
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-launch-budget-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
process.env.MCP_TIMEOUT = '1500'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const client = await import(join(SRC, 'services/mcp/client.ts'))

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
  check('the budget helper is exported from the MCP owner', typeof withBudget === 'function')
  check('the budget reads the connect deadline (MCP_TIMEOUT, live)', budgetMs?.() === 1500, String(budgetMs?.()))
  if (withBudget) {
    const t0 = Date.now()
    const verdict = await withBudget(new Promise(() => {}), 120)
    const took = Date.now() - t0
    check("a batch still settling at the budget answers 'timeout' — the run proceeds", verdict === 'timeout' && took >= 100 && took < 1_000, `${verdict} after ${took}ms`)
    const t1 = Date.now()
    const settled = await withBudget(Promise.resolve(), 5_000)
    check("a settled batch answers 'settled' at once (the timer never holds the run)", settled === 'settled' && Date.now() - t1 < 500, `${settled} after ${Date.now() - t1}ms`)
    const rejected = await withBudget(Promise.reject(new Error('boom')), 5_000)
    check("a rejecting batch still answers 'settled' — the budget never throws", rejected === 'settled', rejected)
  }
}

section('§2 THE DISCOVERY DEADLINE, END TO END')
{
  process.env.MCP_FIXTURE_STALL_TOOLS_LIST = '1'
  const t0 = Date.now()
  const connection = (await client.connectToServer('stall_srv', stdioConfig)) as { type: string }
  check('the stalled server connects (the handshake completes)', connection.type === 'connected', connection.type)
  const tools = (await client.fetchToolsForClient(connection)) as unknown[]
  const took = Date.now() - t0
  check('discovery settles within the deadline window, never the SDK 60s default', took < 6_000, `${took}ms`)
  check('the stalled discovery answers no tools', Array.isArray(tools) && tools.length === 0, String(tools.length))
  const getFailure = client.getToolDiscoveryFailure as ((name: string) => { message: string } | null) | undefined
  const failure = getFailure?.('stall_srv') ?? null
  check('the failure is recorded with its reason (the discovery ladder retries it later)', failure !== null, JSON.stringify(failure))
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
      request: async (req: { method: string }, _schema: unknown, options?: { timeout?: number }) => {
        seen[req.method] = options?.timeout
        return { tools: [], prompts: [], resources: [] }
      },
    },
  }
  await client.fetchToolsForClient(scripted as never)
  await client.fetchCommandsForClient(scripted as never)
  await client.fetchResourcesForClient(scripted as never)
  check('tools/list carries the connect deadline', seen['tools/list'] === 1500, JSON.stringify(seen))
  check('prompts/list carries it', seen['prompts/list'] === 1500, JSON.stringify(seen))
  check('resources/list carries it', seen['resources/list'] === 1500, JSON.stringify(seen))
}

section('§4 THE PRINT PATH (source pins)')
{
  const main = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  check('the batch is raced against the launch budget', main.includes('withMcpLaunchBudget(connectMcpBatch(regularMcpConfigs, store.setState), mcpLaunchBudgetMs())'))
  check('the run proceeds on timeout — late servers serve later calls', main.includes("=== 'timeout') {") && main.includes('late servers serve later calls'))
  check('the helpers are static imports from the one MCP owner', /import \{[^}]*mcpLaunchBudgetMs[^}]*withMcpLaunchBudget[^}]*\} from '\.\/services\/mcp\/client\.js'/s.test(main))
  const print = readFileSync(join(SRC, 'cli/print.ts'), 'utf8')
  check('the headless tool pool reads the MCP store live (a late server serves the next call)', print.includes('() => getAppState().mcp.tools as Tool[]'))
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-headless-mcp-launch-budget: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-headless-mcp-launch-budget: all green')
// The live stdio connection holds the event loop open — the verdict is
// printed; exit hard.
process.exit(0)
