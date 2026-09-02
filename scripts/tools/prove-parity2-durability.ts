#!/usr/bin/env bun
// ============================================================================
//  prove-parity2-durability — frontier-sweep #2, the crash/durability
//  tier, mechanism-pinned:
//
//   1. MCP per-call inactivity watchdog (B20): a stalled tools/call settles
//      as a typed stalled-call error at the idle limit; a slow call that
//      emits progress lives past the limit; the client-level progress
//      ROUTER keeps two concurrent calls' progress separate (the
//      setNotificationHandler-replacement class).
//   2. The agent watchdog's pure pieces (B5.5 + rider R1): the typed stall
//      names the tool-use count; declared provider recovery windows are
//      honored and capped; the knob defaults to 15 minutes.
//   3. Hook-output bound (C28): under-cap text passes untouched; past the
//      cap the model text carries head+tail plus an omission marker naming
//      the spill file, and the spill holds the complete bytes.
//   4. Pathological-input highlight guard (A1.3), through the REAL bundle.
//   5. Quota-aware cores (A13): cgroup v2/v1 quotas bound the host count.
//   6. LSP pending-publish coalesce + bound (packet 47).
//   7. Render-fault recovery ladder (packet 51).
//   8. Fan-out cap + RSS watchdog knob parsing and pure decisions
//      (B5.1/B5.6, RULED conditional).
//   9. Completion-notification inline-result bound (B5.11).
//  10. Absent-tool render shim (packet 66).
//  11. Workflow parallel barrier (B5.9): a leaf that wedges settles through
//      the stall ladder, the barrier releases with the failed slot null,
//      and the following synthesis call still runs.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'parity2-durability-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// —— 1. MCP per-call inactivity watchdog ————————————————————————————————
{
  process.env.MERCURY_MCP_CALL_IDLE_MINUTES = '0.002' // 120ms
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')
  const { callMCPToolWithUrlElicitationRetry, mcpCallIdleLimitMs } = await import('../../src/services/mcp/client.ts')

  t('the idle knob reads 120ms from the minutes flag', mcpCallIdleLimitMs() === 120)

  const server = new Server({ name: 'prover', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'stall', description: 'never answers', inputSchema: { type: 'object' } },
      { name: 'slow-with-progress', description: 'progress then answer', inputSchema: { type: 'object' } },
      { name: 'echo', description: 'answers with its tag', inputSchema: { type: 'object' } },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name
    if (name === 'stall') {
      await new Promise(() => {})
    }
    if (name === 'slow-with-progress') {
      const token = request.params._meta?.progressToken
      for (let i = 1; i <= 4; i++) {
        await sleep(70)
        if (token !== undefined) {
          await server.notification({ method: 'notifications/progress', params: { progressToken: token, progress: i, total: 4 } })
        }
      }
      return { content: [{ type: 'text', text: 'slow done' }] }
    }
    if (name === 'echo') {
      const token = request.params._meta?.progressToken
      if (token !== undefined) {
        await server.notification({ method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 1, message: `from-${String(request.params.arguments?.tag)}` } })
      }
      await sleep(30)
      return { content: [{ type: 'text', text: `echo:${String(request.params.arguments?.tag)}` }] }
    }
    return { content: [{ type: 'text', text: 'unknown' }] }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'prover-client', version: '1.0.0' }, { capabilities: {} })
  await client.connect(clientTransport)
  const connection = {
    type: 'connected' as const,
    name: 'prover',
    client,
    capabilities: {},
    config: { type: 'sdk', name: 'prover', scope: 'session' } as never,
    cleanup: async () => {},
  }

  const parentFor = (id: string, name: string) => ({
    message: { content: [{ type: 'tool_use', id, name, input: {} }] },
  })

  const startedAt = Date.now()
  let stallError: unknown = null
  try {
    await callMCPToolWithUrlElicitationRetry({
      client: connection as never,
      tool: 'stall',
      args: {},
      signal: new AbortController().signal,
      parentMessage: parentFor('tu-stall', 'stall') as never,
    } as never)
  } catch (error) {
    stallError = error
  }
  const stallMessage = stallError instanceof Error ? stallError.message : String(stallError)
  t('a stalled tools/call settles as the typed stalled error', /stalled: no result and no progress/.test(stallMessage), stallMessage)
  t('the stall settles at the idle limit, not the total cap', Date.now() - startedAt < 5_000)
  t('the error names the tuning knob', /MERCURY_MCP_CALL_IDLE_MINUTES/.test(stallMessage))

  const slow = await callMCPToolWithUrlElicitationRetry({
    client: connection as never,
    tool: 'slow-with-progress',
    args: {},
    signal: new AbortController().signal,
    parentMessage: parentFor('tu-slow', 'slow-with-progress') as never,
    onProgress: () => {},
  } as never)
  const slowText = JSON.stringify((slow as { content?: unknown }).content ?? slow)
  t('a 280ms call that reports progress survives the 120ms idle limit', /slow done/.test(slowText), slowText)

  const progressSeen: string[] = []
  const messageOf = (p: unknown): string => String((p as { data?: { progressMessage?: string } }).data?.progressMessage)
  const [a, b] = await Promise.all([
    callMCPToolWithUrlElicitationRetry({
      client: connection as never,
      tool: 'echo',
      args: { tag: 'A' },
      signal: new AbortController().signal,
      parentMessage: parentFor('tu-echo-A', 'echo') as never,
      onProgress: (p: unknown) => {
        if (messageOf(p).startsWith('from-')) progressSeen.push(`A:${messageOf(p)}`)
      },
    } as never),
    callMCPToolWithUrlElicitationRetry({
      client: connection as never,
      tool: 'echo',
      args: { tag: 'B' },
      signal: new AbortController().signal,
      parentMessage: parentFor('tu-echo-B', 'echo') as never,
      onProgress: (p: unknown) => {
        if (messageOf(p).startsWith('from-')) progressSeen.push(`B:${messageOf(p)}`)
      },
    } as never),
  ])
  const textOf = (r: unknown) => JSON.stringify((r as { content?: unknown }).content ?? r)
  t('two concurrent calls both settle with their own results', /echo:A/.test(textOf(a)) && /echo:B/.test(textOf(b)))
  t(
    'the progress ROUTER keeps concurrent progress separate (no last-handler-wins)',
    progressSeen.includes('A:from-A') && progressSeen.includes('B:from-B') && !progressSeen.some(s => s === 'A:from-B' || s === 'B:from-A'),
    JSON.stringify(progressSeen),
  )
  delete process.env.MERCURY_MCP_CALL_IDLE_MINUTES
  await client.close().catch(() => {})
  await server.close().catch(() => {})
}

// —— 2. agent watchdog pure pieces ————————————————————————————————————
{
  const { agentStalledError, declaredRecoveryWaitMs, agentIdleLimitMs, DEFAULT_AGENT_IDLE_MINUTES } = await import('../../src/tools/AgentTool/runAgent.ts')
  t('agent idle default is 15 minutes', DEFAULT_AGENT_IDLE_MINUTES === 15 && agentIdleLimitMs() === 15 * 60_000)
  const zero = agentStalledError({ agentType: 'general-purpose', agentId: 'a1', limitMs: 60_000, elapsedMs: 61_000, events: 0, toolUses: 0 })
  t('a zero-tool-use stall says so (rider R1)', /never used a tool/.test(zero.message) && zero.code === 'DEADLINE_EXCEEDED', zero.message)
  const some = agentStalledError({ agentType: 'general-purpose', agentId: 'a2', limitMs: 60_000, elapsedMs: 200_000, events: 9, toolUses: 3 })
  t('a mid-run stall names its tool-use count', /3 tool uses before the silence/.test(some.message), some.message)
  t('declared recovery: api_error retryInMs honored', declaredRecoveryWaitMs({ type: 'system', subtype: 'api_error', retryInMs: 30_000 }) === 30_000)
  t('declared recovery: recoveryTimeoutMs honored when no retry delay', declaredRecoveryWaitMs({ type: 'system', subtype: 'api_error', recoveryTimeoutMs: 45_000 }) === 45_000)
  t('declared recovery: capped at ten minutes', declaredRecoveryWaitMs({ type: 'system', subtype: 'api_error', retryInMs: 3_600_000 }) === 600_000)
  t('an ordinary message declares no recovery', declaredRecoveryWaitMs({ type: 'assistant' }) === 0)
}

// —— 3. hook-output bound (C28) ————————————————————————————————————————
{
  const { boundHookContext, shapeBoundedContext, HOOK_CONTEXT_CAP_CHARS } = await import('../../src/utils/hooks/contextBound.ts')
  const small = boundHookContext('a modest note', 'prover-hook')
  t('under the cap the text passes untouched', small.text === 'a modest note' && !small.truncated)
  const big = 'S'.repeat(HOOK_CONTEXT_CAP_CHARS + 5_000) + 'TAIL-MARKER'
  const bounded = boundHookContext(big, 'prover-hook')
  t('past the cap the text is bounded with an omission marker', bounded.truncated && bounded.text.length < big.length && /characters omitted/.test(bounded.text))
  t('the tail survives (head+tail preview)', bounded.text.endsWith('TAIL-MARKER'))
  t('the marker names the spill file and the spill holds the complete bytes',
    bounded.spilledTo !== undefined && bounded.text.includes(bounded.spilledTo) && readFileSync(bounded.spilledTo, 'utf8') === big)
  const failed = shapeBoundedContext('x'.repeat(100), 40, { error: 'disk said no' })
  t('a failed spill stays honest in the marker', /could not be saved: disk said no/.test(failed.text))
}

// —— 4. highlight guard (A1.3) ————————————————————————————————————————
{
  const { shouldSkipHighlight, getCliHighlightPromise, MAX_HIGHLIGHT_LINE_CHARS } = await import('../../src/utils/cliHighlight.ts')
  t('ordinary code is highlighted territory', !shouldSkipHighlight('const x = 1\nconst y = 2'))
  const minified = 'x'.repeat(MAX_HIGHLIGHT_LINE_CHARS + 1)
  t('a single over-long line skips', shouldSkipHighlight(minified))
  t('a huge blob skips', shouldSkipHighlight('a\n'.repeat(150_000)))
  const api = await getCliHighlightPromise()
  if (api) {
    const out = api.highlight(minified, { language: 'javascript' })
    t('the guarded bundle returns pathological input unpainted (same bytes)', out === minified)
  } else {
    // cli-highlight is an uninstalled optional in-repo (build.ts
    // ALLOWED_LAZY_BARE): the bundle degrades to null here, so the wrapper
    // is proven structurally (the bun-run loadability law) - the guard must
    // sit between the consumer and the library at the ONE bundle seam.
    const source = readFileSync('src/utils/cliHighlight.ts', 'utf8')
    t(
      'the guard wraps the bundle seam (structural - optional dep absent in-repo)',
      source.includes('shouldSkipHighlight(code) ? code : cliHighlight.highlight(code, options)'),
    )
  }
}

// —— 5. quota-aware cores (A13) ————————————————————————————————————————
{
  const { coresFromCgroupQuota, resolveAvailableCores } = await import('../../src/utils/availableCores.ts')
  t('v2 "200000 100000" reads two cores', coresFromCgroupQuota({ cpuMaxText: '200000 100000' }) === 2)
  t('v2 "max 100000" means no quota', coresFromCgroupQuota({ cpuMaxText: 'max 100000' }) === null)
  t('v2 fractional quota rounds up to one', coresFromCgroupQuota({ cpuMaxText: '50000 100000' }) === 1)
  t('v1 quota/period reads cores', coresFromCgroupQuota({ cfsQuotaUs: '400000', cfsPeriodUs: '100000' }) === 4)
  t('v1 quota -1 means none', coresFromCgroupQuota({ cfsQuotaUs: '-1', cfsPeriodUs: '100000' }) === null)
  t('the quota bounds the host count', resolveAvailableCores({ hostCores: 16, affinityCores: 16, quotaCores: 2 }) === 2)
  t('no quota keeps the host count', resolveAvailableCores({ hostCores: 16, affinityCores: null, quotaCores: null }) === 16)
  t('never below one', resolveAvailableCores({ hostCores: 0, affinityCores: 0, quotaCores: null }) === 1)
}

// —— 6. LSP pending coalesce + bound (packet 47) ————————————————————————
{
  const { registerPendingLSPDiagnostic, _pendingForTesting, checkForLSPDiagnostics, MAX_PENDING_PUBLISHES } = await import('../../src/services/lsp/LSPDiagnosticRegistry.ts')
  checkForLSPDiagnostics() // drain whatever an earlier section parked
  const diag = (message: string) => ({ message, severity: 'Error' as const, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } })
  for (let i = 0; i < 50; i++) {
    registerPendingLSPDiagnostic({ serverName: 'ts', files: [{ uri: 'file:///a.ts', diagnostics: [diag(`wave-${i}`)] }] })
  }
  const parked = _pendingForTesting().filter(entry => entry.uris.includes('file:///a.ts'))
  t('fifty publishes for one file coalesce to ONE pending entry', parked.length === 1, String(parked.length))
  registerPendingLSPDiagnostic({ serverName: 'other', files: [{ uri: 'file:///a.ts', diagnostics: [diag('other-server')] }] })
  t('a different server\'s publish for the same file stays separate', _pendingForTesting().filter(e => e.uris.includes('file:///a.ts')).length === 2)
  for (let i = 0; i < MAX_PENDING_PUBLISHES + 40; i++) {
    registerPendingLSPDiagnostic({ serverName: 'flood', files: [{ uri: `file:///f${i}.ts`, diagnostics: [diag('x')] }] })
  }
  t('the pending table is bounded', _pendingForTesting().length <= MAX_PENDING_PUBLISHES)
  checkForLSPDiagnostics()
}

// —— 7. render-fault ladder (packet 51) ————————————————————————————————
{
  const { renderFaultRecoveryPlan, RENDER_FAULT_RETRY_BUDGET } = await import('../../src/ink/ink.tsx')
  t('faults within the budget repaint', renderFaultRecoveryPlan(1) === 'repaint' && renderFaultRecoveryPlan(RENDER_FAULT_RETRY_BUDGET) === 'repaint')
  t('past the budget the fault goes loud', renderFaultRecoveryPlan(RENDER_FAULT_RETRY_BUDGET + 1) === 'loud')
}

// —— 8. RULED-conditional knobs (B5.1 / B5.6) ————————————————————————————
{
  const { agentFanoutCap } = await import('../../src/constants/subagentDoctrine.ts')
  delete process.env.MERCURY_AGENT_FANOUT_CAP
  t('fan-out cap unset ⇒ no mechanical cap', agentFanoutCap() === null)
  process.env.MERCURY_AGENT_FANOUT_CAP = '3'
  t('fan-out cap set ⇒ the integer', agentFanoutCap() === 3)
  process.env.MERCURY_AGENT_FANOUT_CAP = 'lots'
  t('junk ⇒ no cap', agentFanoutCap() === null)
  delete process.env.MERCURY_AGENT_FANOUT_CAP

  const { parsePsRss, decideRssBreaches, childRssLimitMb } = await import('../../src/daemon/rssWatchdog.ts')
  t('rss limit unset ⇒ watchdog off', childRssLimitMb() === null)
  const rss = parsePsRss('  101 512000\n  202 2048000\n garbage line\n')
  t('ps output parses to pid→KiB', rss.get(101) === 512_000 && rss.get(202) === 2_048_000 && rss.size === 2)
  const breaches = decideRssBreaches(
    [
      { short: 'w1', pid: 101, settled: false },
      { short: 'w2', pid: 202, settled: false },
      { short: 'w3', pid: 303, settled: false },
      { short: 'w4', pid: 202, settled: true },
    ],
    rss,
    1024,
  )
  t('only the live child over the limit breaches (settled and unknown pids never do)', breaches.length === 1 && breaches[0]!.short === 'w2' && breaches[0]!.rssMb === 2000, JSON.stringify(breaches))
}

// —— 9. completion-notification bound (B5.11) ——————————————————————————
{
  const { boundNotificationResult, NOTIFICATION_RESULT_CAP_CHARS } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
  t('a normal final message passes untouched', boundNotificationResult('done, see the diff') === 'done, see the diff')
  const big = 'H'.repeat(NOTIFICATION_RESULT_CAP_CHARS * 3) + 'TAIL'
  const bounded = boundNotificationResult(big)
  t('an oversized final message is bounded and points at the output file',
    bounded.length < big.length && /characters omitted/.test(bounded) && /output file named above/.test(bounded) && bounded.endsWith('TAIL'))
}

// —— 10. absent-tool render shim (packet 66) ————————————————————————————
{
  const { findToolForRender } = await import('../../src/tools/MCPTool/absentToolShim.ts')
  const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
  const real = findToolForRender([BashTool] as never, BashTool.name)
  t('a live tool resolves to itself', real === (BashTool as never))
  const shim = findToolForRender([BashTool] as never, 'mcp__gone__lookup')
  t('an absent tool resolves to a named render shim', shim.name === 'mcp__gone__lookup' && shim.userFacingName({} as never) === 'mcp__gone__lookup')
  t('the shim renders (tool-use message renderer present)', typeof shim.renderToolUseMessage === 'function')
  let threw = false
  try {
    await (shim.call as unknown as (a: unknown, b: unknown) => Promise<unknown>)({}, {})
  } catch {
    threw = true
  }
  t('the shim refuses execution', threw)
}

// —— 11. workflow parallel barrier (B5.9) ———————————————————————————————
{
  const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.ts')
  type FakeArgs = { toolUseContext?: { abortController?: AbortController } }
  let spawnCount = 0
  const fakeSpawn = (args: FakeArgs): AsyncGenerator<unknown, void> => {
    const index = spawnCount++
    async function* healthy(): AsyncGenerator<unknown, void> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: `leaf-${index} ok` }] } }
    }
    async function* wedged(): AsyncGenerator<unknown, void> {
      await new Promise<void>(resolve => {
        const signal = args.toolUseContext?.abortController?.signal
        if (signal?.aborted) return resolve()
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      throw new Error('aborted by watchdog')
    }
    // The FIRST spawn is healthy; every later spawn (the wedged leaf and
    // all of its stall-ladder retries) wedges - the leaf never recovers.
    return index === 0 || index >= 100 ? healthy() : wedged()
  }
  const hooks = makeWorkflowHooks({
    toolUseContext: {
      abortController: new AbortController(),
      getAppState: () => ({
        toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} },
        mcp: { tools: [] },
      }),
      options: { agentDefinitions: { activeAgents: [] }, mainLoopModel: 'claude-opus-5' },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: () => {},
    workflowRunId: undefined,
    onAgentController: () => {},
    seedPhaseTitles: [],
    args: undefined,
    spawnSubagentStream: fakeSpawn as never,
  } as never) as unknown as {
    agent: (p: string, o?: Record<string, unknown>) => Promise<unknown>
    parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>
    getFailures?: () => string[]
  }
  const startedAt = Date.now()
  const slots = await hooks.parallel([
    () => hooks.agent('healthy leaf', { stallMs: 300, retries: 0 }),
    () => hooks.agent('wedged leaf', { stallMs: 300, retries: 0 }),
  ])
  t('the barrier releases even with a wedged leaf', Array.isArray(slots), `took ${Date.now() - startedAt}ms`)
  const healthySlot = (slots as unknown[])[0]
  const wedgedSlot = (slots as unknown[])[1]
  t('the healthy slot carries its result', typeof healthySlot === 'string' && /leaf-0 ok/.test(healthySlot), JSON.stringify(healthySlot))
  t('the wedged slot settles null (never rejects, never hangs)', wedgedSlot === null)
  t('the lost leaf is a recorded failure, not a silent null', (hooks.getFailures?.() ?? []).some(f => f.includes('parallel[1] failed')), JSON.stringify(hooks.getFailures?.()))
  spawnCount = 200 // healthy lane for the synthesis spawn
  const synthesis = await hooks.agent('synthesis over partial results', { stallMs: 2_000 })
  t('synthesis still launches and completes after the lost leaf', typeof synthesis === 'string' && /ok/.test(synthesis))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
