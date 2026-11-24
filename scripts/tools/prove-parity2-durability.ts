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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
  if (!ok) failures = 1
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

{
  process.env.MERCURY_MCP_CALL_IDLE_MINUTES = '0.002'
  const { Client } = await import('@modelcontextprotocol/client')
  const { InMemoryTransport, Server } = await import('@modelcontextprotocol/server')
  const mcp = await import('../../src/integrations/mcp/client.ts')
  const { callMCPToolWithUrlElicitationRetry, mcpCallIdleLimitMs } = mcp

  t('the idle knob reads 120ms from the minutes flag', mcpCallIdleLimitMs() === 120, '', 'fix mcpCallIdleLimitMs in src/integrations/mcp/client/limits.ts so MERCURY_MCP_CALL_IDLE_MINUTES=0.002 reads as 120 ms')

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
  t('a stalled tools/call settles as an unknown outcome', /unknown outcome/.test(stallMessage), stallMessage, 'a stalled tools/call must reject with an unknown-outcome message from callMCPToolWithUrlElicitationRetry in src/integrations/mcp/client.ts')
  t('the stall settles at the idle limit, not the total cap', Date.now() - startedAt < 5_000, '', 'the idle limit (mcpCallIdleLimitMs, used in src/integrations/mcp/client.ts) must end a silent call before the total cap')
  t('the error names the action and inspection before retrying', /tool "stall" on server "prover".*inspect the effect before retrying/.test(stallMessage), '', 'the stall error in src/integrations/mcp/client.ts must name the tool, the server and say to inspect the effect before retrying')

  const slow = await callMCPToolWithUrlElicitationRetry({
    client: connection as never,
    tool: 'slow-with-progress',
    args: {},
    signal: new AbortController().signal,
    parentMessage: parentFor('tu-slow', 'slow-with-progress') as never,
    onProgress: () => {},
  } as never)
  const slowText = JSON.stringify((slow as { content?: unknown }).content ?? slow)
  t('a 280ms call that reports progress survives the 120ms idle limit', /slow done/.test(slowText), slowText, 'progress notifications must reset the idle timer in callMCPToolWithUrlElicitationRetry in src/integrations/mcp/client.ts')

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
  t('two concurrent calls both settle with their own results', /echo:A/.test(textOf(a)) && /echo:B/.test(textOf(b)), '', 'concurrent calls through callMCPToolWithUrlElicitationRetry in src/integrations/mcp/client.ts must each settle with their own result')
  t(
    'the progress ROUTER keeps concurrent progress separate (no last-handler-wins)',
    progressSeen.includes('A:from-A') && progressSeen.includes('B:from-B') && !progressSeen.some(s => s === 'A:from-B' || s === 'B:from-A'),
    JSON.stringify(progressSeen),
    'route each progress notification to the handler of its own call in src/integrations/mcp/client.ts, keyed by progress token',
  )
  delete process.env.MERCURY_MCP_CALL_IDLE_MINUTES
  unseat()
  await client.close().catch(() => {})
  await server.close().catch(() => {})
}

{
  const { crewmateStalledError, declaredRecoveryWaitMs, crewmateIdleLimitMs, DEFAULT_CREWMATE_IDLE_MINUTES } = await import('../../src/tools/crewmate/runCrewmate.ts')
  t('agent idle default is 15 minutes', DEFAULT_CREWMATE_IDLE_MINUTES === 15 && crewmateIdleLimitMs() === 15 * 60_000, '', 'DEFAULT_AGENT_IDLE_MINUTES and agentIdleLimitMs in src/tools/crewmate/runCrewmate.ts must default to 15 minutes')
  const zero = crewmateStalledError({ agentType: 'mercury-crew', agentId: 'a1', limitMs: 60_000, elapsedMs: 61_000, events: 0, toolUses: 0 })
  t('a zero-tool-use stall says so (rider R1)', /never used a tool/.test(zero.message) && zero.code === 'DEADLINE_EXCEEDED', zero.message, 'agentStalledError in src/tools/crewmate/runCrewmate.ts must say the agent never used a tool, with code DEADLINE_EXCEEDED')
  const some = crewmateStalledError({ agentType: 'mercury-crew', agentId: 'a2', limitMs: 60_000, elapsedMs: 200_000, events: 9, toolUses: 3 })
  t('a mid-run stall names its tool-use count', /3 tool uses before the silence/.test(some.message), some.message, 'agentStalledError in src/tools/crewmate/runCrewmate.ts must name the tool-use count')
  t('declared recovery: api_error retryInMs honored', declaredRecoveryWaitMs({ type: 'system', subtype: 'api_error', retryInMs: 30_000 }) === 30_000, '', 'declaredRecoveryWaitMs in src/tools/crewmate/runCrewmate.ts must honor retryInMs on an api_error system message')
  t('declared recovery: recoveryTimeoutMs honored when no retry delay', declaredRecoveryWaitMs({ type: 'system', subtype: 'api_error', recoveryTimeoutMs: 45_000 }) === 45_000, '', 'declaredRecoveryWaitMs in src/tools/crewmate/runCrewmate.ts must fall back to recoveryTimeoutMs when no retry delay is given')
  t('declared recovery: capped at ten minutes', declaredRecoveryWaitMs({ type: 'system', subtype: 'api_error', retryInMs: 3_600_000 }) === 600_000, '', 'declaredRecoveryWaitMs in src/tools/crewmate/runCrewmate.ts must cap the wait at ten minutes')
  t('an ordinary message declares no recovery', declaredRecoveryWaitMs({ type: 'assistant' }) === 0, '', 'declaredRecoveryWaitMs in src/tools/crewmate/runCrewmate.ts must return 0 for a message that declares no recovery')
}

{
  const { boundHookContext, shapeBoundedContext, HOOK_CONTEXT_CAP_CHARS } = await import('../../src/integrations/event-hooks/contextBound.ts')
  const small = boundHookContext('a modest note', 'prover-hook')
  t('under the cap the text passes untouched', small.text === 'a modest note' && !small.truncated, '', 'boundHookContext in src/integrations/event-hooks/contextBound.ts must return text under HOOK_CONTEXT_CAP_CHARS unchanged')
  const big = 'S'.repeat(HOOK_CONTEXT_CAP_CHARS + 5_000) + 'TAIL-MARKER'
  const bounded = boundHookContext(big, 'prover-hook')
  t('past the cap the text is bounded with an omission marker', bounded.truncated && bounded.text.length < big.length && /characters omitted/.test(bounded.text), '', 'boundHookContext in src/integrations/event-hooks/contextBound.ts must shorten text past the cap and add a characters-omitted marker')
  t('the tail survives (head+tail preview)', bounded.text.endsWith('TAIL-MARKER'), '', 'boundHookContext in src/integrations/event-hooks/contextBound.ts must keep the tail of the text after the omission marker')
  t('the marker names the spill file and the spill holds the complete bytes',
    bounded.spilledTo !== undefined && bounded.text.includes(bounded.spilledTo) && readFileSync(bounded.spilledTo, 'utf8') === big, '', 'boundHookContext in src/integrations/event-hooks/contextBound.ts must save the full text to a spill file and name that path in the marker')
  const failed = shapeBoundedContext('x'.repeat(100), 40, { error: 'disk said no' })
  t('a failed spill stays honest in the marker', /could not be saved: disk said no/.test(failed.text), '', 'shapeBoundedContext in src/integrations/event-hooks/contextBound.ts must print the spill error in the marker')
}

{
  const { shouldSkipHighlight, getCliHighlightPromise, MAX_HIGHLIGHT_LINE_CHARS } = await import('../../src/screen/highlighted-code/cliHighlight.ts')
  t('ordinary code is highlighted territory', !shouldSkipHighlight('const x = 1\nconst y = 2'), '', 'shouldSkipHighlight in src/screen/highlighted-code/cliHighlight.ts must not skip ordinary short code')
  const minified = 'x'.repeat(MAX_HIGHLIGHT_LINE_CHARS + 1)
  t('a single over-long line skips', shouldSkipHighlight(minified), '', 'shouldSkipHighlight in src/screen/highlighted-code/cliHighlight.ts must skip a line longer than MAX_HIGHLIGHT_LINE_CHARS')
  t('a huge blob skips', shouldSkipHighlight('a\n'.repeat(150_000)), '', 'shouldSkipHighlight in src/screen/highlighted-code/cliHighlight.ts must skip a very large blob')
  const api = await getCliHighlightPromise()
  if (api) {
    const out = api.highlight(minified, { language: 'javascript' })
    t('the guarded bundle returns pathological input unpainted (same bytes)', out === minified, '', 'the highlighter from getCliHighlightPromise in src/screen/highlighted-code/cliHighlight.ts must return over-long input unchanged')
  } else {
  }
}

{
  const { coresFromCgroupQuota, resolveAvailableCores } = await import('../../src/platform/processes/availableCores.ts')
  t('v2 "200000 100000" reads two cores', coresFromCgroupQuota({ cpuMaxText: '200000 100000' }) === 2, '', 'coresFromCgroupQuota in src/platform/processes/availableCores.ts must read a v2 cpu.max quota/period pair as cores')
  t('v2 "max 100000" means no quota', coresFromCgroupQuota({ cpuMaxText: 'max 100000' }) === null, '', 'coresFromCgroupQuota in src/platform/processes/availableCores.ts must return null when cpu.max says max')
  t('v2 fractional quota rounds up to one', coresFromCgroupQuota({ cpuMaxText: '50000 100000' }) === 1, '', 'coresFromCgroupQuota in src/platform/processes/availableCores.ts must round a fractional quota up')
  t('v1 quota/period reads cores', coresFromCgroupQuota({ cfsQuotaUs: '400000', cfsPeriodUs: '100000' }) === 4, '', 'coresFromCgroupQuota in src/platform/processes/availableCores.ts must read a v1 quota/period pair as cores')
  t('v1 quota -1 means none', coresFromCgroupQuota({ cfsQuotaUs: '-1', cfsPeriodUs: '100000' }) === null, '', 'coresFromCgroupQuota in src/platform/processes/availableCores.ts must return null for a v1 quota of -1')
  t('the quota bounds the host count', resolveAvailableCores({ hostCores: 16, affinityCores: 16, quotaCores: 2 }) === 2, '', 'resolveAvailableCores in src/platform/processes/availableCores.ts must let the quota bound the host count')
  t('no quota keeps the host count', resolveAvailableCores({ hostCores: 16, affinityCores: null, quotaCores: null }) === 16, '', 'resolveAvailableCores in src/platform/processes/availableCores.ts must keep the host count when there is no quota')
  t('never below one', resolveAvailableCores({ hostCores: 0, affinityCores: 0, quotaCores: null }) === 1, '', 'resolveAvailableCores in src/platform/processes/availableCores.ts must never return less than one')
}

{
  const { registerPendingLSPDiagnostic, _pendingForTesting, checkForLSPDiagnostics, MAX_PENDING_PUBLISHES } = await import('../../src/integrations/lsp/LSPDiagnosticRegistry.ts')
  checkForLSPDiagnostics()
  const diag = (message: string) => ({ message, severity: 'Error' as const, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } })
  for (let i = 0; i < 50; i++) {
    registerPendingLSPDiagnostic({ serverName: 'ts', files: [{ uri: 'file:///a.ts', diagnostics: [diag(`wave-${i}`)] }] })
  }
  const parked = _pendingForTesting().filter(entry => entry.uris.includes('file:///a.ts'))
  t('fifty publishes for one file coalesce to ONE pending entry', parked.length === 1, String(parked.length), 'registerPendingLSPDiagnostic in src/integrations/lsp/LSPDiagnosticRegistry.ts must replace the pending entry of the same server and file, not add one')
  registerPendingLSPDiagnostic({ serverName: 'other', files: [{ uri: 'file:///a.ts', diagnostics: [diag('other-server')] }] })
  t('a different server\'s publish for the same file stays separate', _pendingForTesting().filter(e => e.uris.includes('file:///a.ts')).length === 2, '', 'registerPendingLSPDiagnostic in src/integrations/lsp/LSPDiagnosticRegistry.ts must key pending entries by server as well as file')
  for (let i = 0; i < MAX_PENDING_PUBLISHES + 40; i++) {
    registerPendingLSPDiagnostic({ serverName: 'flood', files: [{ uri: `file:///f${i}.ts`, diagnostics: [diag('x')] }] })
  }
  t('the pending table is bounded', _pendingForTesting().length <= MAX_PENDING_PUBLISHES, '', 'registerPendingLSPDiagnostic in src/integrations/lsp/LSPDiagnosticRegistry.ts must drop entries past MAX_PENDING_PUBLISHES')
  checkForLSPDiagnostics()
}

{
  const { renderFaultRecoveryPlan, RENDER_FAULT_RETRY_BUDGET } = await import('../../src/screen/renderer/screenInstance.tsx')
  t('faults within the budget repaint', renderFaultRecoveryPlan(1) === 'repaint' && renderFaultRecoveryPlan(RENDER_FAULT_RETRY_BUDGET) === 'repaint', '', 'renderFaultRecoveryPlan (exported through src/screen/renderer/screenInstance.tsx) must answer repaint up to RENDER_FAULT_RETRY_BUDGET')
  t('past the budget the fault goes loud', renderFaultRecoveryPlan(RENDER_FAULT_RETRY_BUDGET + 1) === 'loud', '', 'renderFaultRecoveryPlan (exported through src/screen/renderer/screenInstance.tsx) must answer loud past RENDER_FAULT_RETRY_BUDGET')
}

{
  const { crewmateFanoutCap } = await import('../../src/tools/crewmate/subagentDoctrine.ts')
  delete process.env.MERCURY_AGENT_FANOUT_CAP
  t('fan-out cap unset ⇒ no mechanical cap', crewmateFanoutCap() === null, '', 'agentFanoutCap in src/tools/crewmate/subagentDoctrine.ts must return null when MERCURY_AGENT_FANOUT_CAP is unset')
  process.env.MERCURY_AGENT_FANOUT_CAP = '3'
  t('fan-out cap set ⇒ the integer', crewmateFanoutCap() === 3, '', 'agentFanoutCap in src/tools/crewmate/subagentDoctrine.ts must return the integer in MERCURY_AGENT_FANOUT_CAP')
  process.env.MERCURY_AGENT_FANOUT_CAP = 'lots'
  t('junk ⇒ no cap', crewmateFanoutCap() === null, '', 'agentFanoutCap in src/tools/crewmate/subagentDoctrine.ts must return null when MERCURY_AGENT_FANOUT_CAP is not a number')
  delete process.env.MERCURY_AGENT_FANOUT_CAP
}

{
  const { boundNotificationResult, NOTIFICATION_RESULT_CAP_CHARS } = await import('../../src/engine/tasks/local-agent/crewmateTask.tsx')
  t('a normal final message passes untouched', boundNotificationResult('done, see the diff') === 'done, see the diff', '', 'boundNotificationResult in src/engine/tasks/local-agent/crewmateTask.tsx must return a short message unchanged')
  const big = 'H'.repeat(NOTIFICATION_RESULT_CAP_CHARS * 3) + 'TAIL'
  const bounded = boundNotificationResult(big)
  t('an oversized final message is bounded and points at the output file',
    bounded.length < big.length && /characters omitted/.test(bounded) && /output file named above/.test(bounded) && bounded.endsWith('TAIL'), '', 'boundNotificationResult in src/engine/tasks/local-agent/crewmateTask.tsx must shorten past NOTIFICATION_RESULT_CAP_CHARS, say characters omitted, point at the output file and keep the tail')
}

{
  const { findToolForRender } = await import('../../src/tools/mcp/absentToolShim.ts')
  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  const real = findToolForRender([BashTool] as never, BashTool.name)
  t('a live tool resolves to itself', real === (BashTool as never), '', 'findToolForRender in src/tools/mcp/absentToolShim.ts must return the live tool when the name is in the list')
  const shim = findToolForRender([BashTool] as never, 'mcp__gone__lookup')
  t('an absent tool resolves to a named render shim', shim.name === 'mcp__gone__lookup' && shim.userFacingName({} as never) === 'mcp__gone__lookup', '', 'findToolForRender in src/tools/mcp/absentToolShim.ts must return a shim named after the absent tool')
  t('the shim renders (tool-use message renderer present)', typeof shim.renderToolUseMessage === 'function', '', 'the shim from findToolForRender in src/tools/mcp/absentToolShim.ts must carry renderToolUseMessage')
  let threw = false
  try {
    await (shim.call as unknown as (a: unknown, b: unknown) => Promise<unknown>)({}, {})
  } catch {
    threw = true
  }
  t('the shim refuses execution', threw, '', 'the shim call in src/tools/mcp/absentToolShim.ts must throw instead of running')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
