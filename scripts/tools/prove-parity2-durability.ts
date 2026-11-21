#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inProcessServerConfig, seatInProcessServer } from '../lib/mcpInProcess.ts'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'parity2-durability-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = '', hint = ''): void => {
  const shown = ok ? detail : [detail, hint].filter(Boolean).join(' — ')
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${shown ? ` — ${shown}` : ''}`)
  if (!ok) failures = 1
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

{
  process.env.MERCURY_MCP_CALL_IDLE_MINUTES = '0.002'
  const { Client } = await import('@modelcontextprotocol/client')
  const { InMemoryTransport, Server } = await import('@modelcontextprotocol/server')
  const mcp = await import('../../src/services/mcp/client.ts')
  const { callMCPToolWithUrlElicitationRetry, mcpCallIdleLimitMs } = mcp

  t('the idle knob reads 120ms from the minutes flag', mcpCallIdleLimitMs() === 120, '', 'mcpCallIdleLimitMs in src/services/mcp/client.ts must convert MERCURY_MCP_CALL_IDLE_MINUTES (minutes) to milliseconds')

  const server = new Server({ name: 'prover', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', async () => ({
    tools: [
      { name: 'stall', description: 'never answers', inputSchema: { type: 'object' } },
      { name: 'slow-with-progress', description: 'progress then answer', inputSchema: { type: 'object' } },
      { name: 'echo', description: 'answers with its tag', inputSchema: { type: 'object' } },
    ],
  }))
  server.setRequestHandler('tools/call', async request => {
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
    config: inProcessServerConfig('prover'),
    cleanup: async () => {},
  }
  const unseat = seatInProcessServer(mcp, connection)

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
  t('a stalled tools/call settles as an unknown outcome', /unknown outcome/.test(stallMessage), stallMessage, 'callMCPToolWithUrlElicitationRetry in src/services/mcp/client.ts must reject a tools/call that goes silent with an error saying unknown outcome')
  t('the stall settles at the idle limit, not the total cap', Date.now() - startedAt < 5_000, '', 'callMCPToolWithUrlElicitationRetry in src/services/mcp/client.ts must settle a silent call at the idle limit (MERCURY_MCP_CALL_IDLE_MINUTES), not wait for the total cap')
  t('the error names the action and inspection before retrying', /tool "stall" on server "prover".*inspect the effect before retrying/.test(stallMessage), stallMessage, 'the stall error built in src/services/mcp/client.ts must name the tool and server and tell the reader to inspect the effect before retrying')

  const slow = await callMCPToolWithUrlElicitationRetry({
    client: connection as never,
    tool: 'slow-with-progress',
    args: {},
    signal: new AbortController().signal,
    parentMessage: parentFor('tu-slow', 'slow-with-progress') as never,
    onProgress: () => {},
  } as never)
  const slowText = JSON.stringify((slow as { content?: unknown }).content ?? slow)
  t('a 280ms call that reports progress survives the 120ms idle limit', /slow done/.test(slowText), slowText, 'callMCPToolWithUrlElicitationRetry in src/services/mcp/client.ts must keep a call alive while it reports progress')

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
  t('two concurrent calls both settle with their own results', /echo:A/.test(textOf(a)) && /echo:B/.test(textOf(b)), '', 'concurrent callMCPToolWithUrlElicitationRetry calls in src/services/mcp/client.ts must each return their own result')
  t(
    'the progress ROUTER keeps concurrent progress separate (no last-handler-wins)',
    progressSeen.includes('A:from-A') && progressSeen.includes('B:from-B') && !progressSeen.some(s => s === 'A:from-B' || s === 'B:from-A'),
    JSON.stringify(progressSeen),
    'the progress routing used by callMCPToolWithUrlElicitationRetry in src/services/mcp/client.ts must deliver each progress token to the handler of its own call',
  )
  delete process.env.MERCURY_MCP_CALL_IDLE_MINUTES
  unseat()
  await client.close().catch(() => {})
  await server.close().catch(() => {})
}

{
  const { agentStalledError, declaredRecoveryWaitMs, agentIdleLimitMs, DEFAULT_AGENT_IDLE_MINUTES } = await import('../../src/tools/AgentTool/runAgent.ts')
  t('agent idle default is 15 minutes', DEFAULT_AGENT_IDLE_MINUTES === 15 && agentIdleLimitMs() === 15 * 60_000, '', 'DEFAULT_AGENT_IDLE_MINUTES and agentIdleLimitMs in src/tools/AgentTool/runAgent.ts must default to 15 minutes')
  const zero = agentStalledError({ agentType: 'mercury-crew', agentId: 'a1', limitMs: 60_000, elapsedMs: 61_000, events: 0, toolUses: 0 })
  t('a zero-tool-use stall says so (rider R1)', /never used a tool/.test(zero.message) && zero.code === 'DEADLINE_EXCEEDED', zero.message, 'agentStalledError in src/tools/AgentTool/runAgent.ts must say the agent never used a tool when toolUses is 0 and carry code DEADLINE_EXCEEDED')
  const some = agentStalledError({ agentType: 'mercury-crew', agentId: 'a2', limitMs: 60_000, elapsedMs: 200_000, events: 9, toolUses: 3 })
  t('a mid-run stall names its tool-use count', /3 tool uses before the silence/.test(some.message), some.message, 'agentStalledError in src/tools/AgentTool/runAgent.ts must name the tool-use count before the silence')
  t('declared recovery: api_error retryInMs honored', declaredRecoveryWaitMs({ type: 'system', subtype: 'api_error', retryInMs: 30_000 }) === 30_000, '', 'declaredRecoveryWaitMs in src/tools/AgentTool/runAgent.ts must return retryInMs of an api_error system message')
  t('declared recovery: recoveryTimeoutMs honored when no retry delay', declaredRecoveryWaitMs({ type: 'system', subtype: 'api_error', recoveryTimeoutMs: 45_000 }) === 45_000, '', 'declaredRecoveryWaitMs in src/tools/AgentTool/runAgent.ts must fall back to recoveryTimeoutMs when there is no retryInMs')
  t('declared recovery: capped at ten minutes', declaredRecoveryWaitMs({ type: 'system', subtype: 'api_error', retryInMs: 3_600_000 }) === 600_000, '', 'declaredRecoveryWaitMs in src/tools/AgentTool/runAgent.ts must cap the wait at ten minutes')
  t('an ordinary message declares no recovery', declaredRecoveryWaitMs({ type: 'assistant' }) === 0, '', 'declaredRecoveryWaitMs in src/tools/AgentTool/runAgent.ts must return 0 for a message that is not an api_error')
}

{
  const { boundHookContext, shapeBoundedContext, HOOK_CONTEXT_CAP_CHARS } = await import('../../src/utils/hooks/contextBound.ts')
  const small = boundHookContext('a modest note', 'prover-hook')
  t('under the cap the text passes untouched', small.text === 'a modest note' && !small.truncated, '', 'boundHookContext in src/utils/hooks/contextBound.ts must return text under HOOK_CONTEXT_CAP_CHARS unchanged')
  const big = 'S'.repeat(HOOK_CONTEXT_CAP_CHARS + 5_000) + 'TAIL-MARKER'
  const bounded = boundHookContext(big, 'prover-hook')
  t('past the cap the text is bounded with an omission marker', bounded.truncated && bounded.text.length < big.length && /characters omitted/.test(bounded.text), '', 'boundHookContext in src/utils/hooks/contextBound.ts must truncate past HOOK_CONTEXT_CAP_CHARS and add a characters-omitted marker')
  t('the tail survives (head+tail preview)', bounded.text.endsWith('TAIL-MARKER'), '', 'boundHookContext in src/utils/hooks/contextBound.ts must keep the end of the text (head plus tail preview)')
  t('the marker names the spill file and the spill holds the complete bytes',
    bounded.spilledTo !== undefined && bounded.text.includes(bounded.spilledTo) && readFileSync(bounded.spilledTo, 'utf8') === big, '', 'boundHookContext in src/utils/hooks/contextBound.ts must write the full text to a spill file and name that path in the marker')
  const failed = shapeBoundedContext('x'.repeat(100), 40, { error: 'disk said no' })
  t('a failed spill stays honest in the marker', /could not be saved: disk said no/.test(failed.text), failed.text, 'shapeBoundedContext in src/utils/hooks/contextBound.ts must put the spill error in the marker as could not be saved')
}

{
  const { shouldSkipHighlight, getCliHighlightPromise, MAX_HIGHLIGHT_LINE_CHARS } = await import('../../src/utils/cliHighlight.ts')
  t('ordinary code is highlighted territory', !shouldSkipHighlight('const x = 1\nconst y = 2'), '', 'shouldSkipHighlight in src/utils/cliHighlight.ts must not skip short ordinary code')
  const minified = 'x'.repeat(MAX_HIGHLIGHT_LINE_CHARS + 1)
  t('a single over-long line skips', shouldSkipHighlight(minified), '', 'shouldSkipHighlight in src/utils/cliHighlight.ts must skip a line longer than MAX_HIGHLIGHT_LINE_CHARS')
  t('a huge blob skips', shouldSkipHighlight('a\n'.repeat(150_000)), '', 'shouldSkipHighlight in src/utils/cliHighlight.ts must skip a very large input')
  const api = await getCliHighlightPromise()
  if (api) {
    const out = api.highlight(minified, { language: 'javascript' })
    t('the guarded bundle returns pathological input unpainted (same bytes)', out === minified, '', 'the highlighter from getCliHighlightPromise in src/utils/cliHighlight.ts must return an over-long line unchanged')
  } else {
  }
}

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

{
  const { registerPendingLSPDiagnostic, _pendingForTesting, checkForLSPDiagnostics, MAX_PENDING_PUBLISHES } = await import('../../src/services/lsp/LSPDiagnosticRegistry.ts')
  checkForLSPDiagnostics()
  const diag = (message: string) => ({ message, severity: 'Error' as const, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } })
  for (let i = 0; i < 50; i++) {
    registerPendingLSPDiagnostic({ serverName: 'ts', files: [{ uri: 'file:///a.ts', diagnostics: [diag(`wave-${i}`)] }] })
  }
  const parked = _pendingForTesting().filter(entry => entry.uris.includes('file:///a.ts'))
  t('fifty publishes for one file coalesce to ONE pending entry', parked.length === 1, String(parked.length), 'registerPendingLSPDiagnostic in src/services/lsp/LSPDiagnosticRegistry.ts must replace the pending entry of the same server and file')
  registerPendingLSPDiagnostic({ serverName: 'other', files: [{ uri: 'file:///a.ts', diagnostics: [diag('other-server')] }] })
  t('a different server\'s publish for the same file stays separate', _pendingForTesting().filter(e => e.uris.includes('file:///a.ts')).length === 2)
  for (let i = 0; i < MAX_PENDING_PUBLISHES + 40; i++) {
    registerPendingLSPDiagnostic({ serverName: 'flood', files: [{ uri: `file:///f${i}.ts`, diagnostics: [diag('x')] }] })
  }
  t('the pending table is bounded', _pendingForTesting().length <= MAX_PENDING_PUBLISHES, '', 'registerPendingLSPDiagnostic in src/services/lsp/LSPDiagnosticRegistry.ts must keep the pending table within MAX_PENDING_PUBLISHES')
  checkForLSPDiagnostics()
}

{
  const { renderFaultRecoveryPlan, RENDER_FAULT_RETRY_BUDGET } = await import('../../src/ink/ink.tsx')
  t('faults within the budget repaint', renderFaultRecoveryPlan(1) === 'repaint' && renderFaultRecoveryPlan(RENDER_FAULT_RETRY_BUDGET) === 'repaint', '', 'renderFaultRecoveryPlan in src/ink/ink.tsx must answer repaint up to RENDER_FAULT_RETRY_BUDGET faults')
  t('past the budget the fault goes loud', renderFaultRecoveryPlan(RENDER_FAULT_RETRY_BUDGET + 1) === 'loud', '', 'renderFaultRecoveryPlan in src/ink/ink.tsx must answer loud once the budget is exceeded')
}

{
  const { agentFanoutCap } = await import('../../src/constants/subagentDoctrine.ts')
  delete process.env.MERCURY_AGENT_FANOUT_CAP
  t('fan-out cap unset ⇒ no mechanical cap', agentFanoutCap() === null, '', 'agentFanoutCap in src/constants/subagentDoctrine.ts must return null when MERCURY_AGENT_FANOUT_CAP is unset')
  process.env.MERCURY_AGENT_FANOUT_CAP = '3'
  t('fan-out cap set ⇒ the integer', agentFanoutCap() === 3, '', 'agentFanoutCap in src/constants/subagentDoctrine.ts must return the integer in MERCURY_AGENT_FANOUT_CAP')
  process.env.MERCURY_AGENT_FANOUT_CAP = 'lots'
  t('junk ⇒ no cap', agentFanoutCap() === null, '', 'agentFanoutCap in src/constants/subagentDoctrine.ts must return null for a value that is not an integer')
  delete process.env.MERCURY_AGENT_FANOUT_CAP
}

{
  const { boundNotificationResult, NOTIFICATION_RESULT_CAP_CHARS } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
  t('a normal final message passes untouched', boundNotificationResult('done, see the diff') === 'done, see the diff', '', 'boundNotificationResult in src/tasks/LocalAgentTask/LocalAgentTask.tsx must return a message under NOTIFICATION_RESULT_CAP_CHARS unchanged')
  const big = 'H'.repeat(NOTIFICATION_RESULT_CAP_CHARS * 3) + 'TAIL'
  const bounded = boundNotificationResult(big)
  t('an oversized final message is bounded and points at the output file',
    bounded.length < big.length && /characters omitted/.test(bounded) && /output file named above/.test(bounded) && bounded.endsWith('TAIL'), '', 'boundNotificationResult in src/tasks/LocalAgentTask/LocalAgentTask.tsx must truncate past NOTIFICATION_RESULT_CAP_CHARS, keep the tail and point at the output file')
}

{
  const { findToolForRender } = await import('../../src/tools/MCPTool/absentToolShim.ts')
  const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
  const real = findToolForRender([BashTool] as never, BashTool.name)
  t('a live tool resolves to itself', real === (BashTool as never), '', 'findToolForRender in src/tools/MCPTool/absentToolShim.ts must return the live tool when it is in the list')
  const shim = findToolForRender([BashTool] as never, 'mcp__gone__lookup')
  t('an absent tool resolves to a named render shim', shim.name === 'mcp__gone__lookup' && shim.userFacingName({} as never) === 'mcp__gone__lookup', '', 'findToolForRender in src/tools/MCPTool/absentToolShim.ts must return a shim named after the absent tool')
  t('the shim renders (tool-use message renderer present)', typeof shim.renderToolUseMessage === 'function', '', 'the shim built in src/tools/MCPTool/absentToolShim.ts must define renderToolUseMessage')
  let threw = false
  try {
    await (shim.call as unknown as (a: unknown, b: unknown) => Promise<unknown>)({}, {})
  } catch {
    threw = true
  }
  t('the shim refuses execution', threw, '', 'the shim built in src/tools/MCPTool/absentToolShim.ts must throw when its call is invoked')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
