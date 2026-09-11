#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'

process.chdir(resolve(import.meta.dir, '../..'))
const scratch = mkdtempSync(join(tmpdir(), 'tool-concurrency-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(scratch, 'teams')
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
bootstrap.setCwdState(scratch)
const { buildToolCensus } = await import('../../src/utils/capability/census.ts')
const { runTools } = await import('../../src/services/tools/toolOrchestration.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ': ' + detail : ''}`)
  if (!ok) failures++
}
const watchdog = setTimeout(() => process.exit(1), 30000)
try {
  const census = buildToolCensus()
  const required = ['Edit', 'Write', 'ExitStrategyMode', 'TaskStop', 'ApolloReview', 'Monitor', 'Read', 'Grep', 'Glob', 'ToolSearch']
  check('the census includes execution, mutation, planning and read tools', required.every(name => census.rows.some(row => row.name === name)))
  for (const row of census.rows) {
    check(`${row.name}: a non-read-only tool never advertises safe concurrency`, row.readOnlyProbe !== false || row.concurrencySafeProbe !== true)
  }
  for (const name of ['TaskStop', 'ApolloReview', 'Monitor']) {
    const row = census.rows.find(row => row.name === name)
    check(`${name}: execution or permission state changes serialize`, row?.readOnlyProbe === false && row.concurrencySafeProbe === false)
  }
  for (const [safe, count] of [[true, 5], [false, 3]] as const) {
    let active = 0
    let peak = 0
    const spans: Array<{ start: number; end: number }> = []
    const delay = 180
    const tool = {
      name: 'SlowFixture',
      inputSchema: z.object({ text: z.string() }),
      async description() { return 'A timed fixture operation' },
      async prompt() { return 'A timed fixture operation' },
      userFacingName: () => 'SlowFixture',
      isEnabled: () => true,
      isConcurrencySafe: () => safe,
      isReadOnly: () => safe,
      isMcp: false,
      needsPermissions: () => false,
      async validateInput() { return { result: true } },
      async call(input: { text: string }) {
        const span = { start: performance.now(), end: 0 }
        spans.push(span)
        peak = Math.max(peak, ++active)
        await new Promise(resolveTick => setTimeout(resolveTick, delay))
        active--
        span.end = performance.now()
        return { data: input.text }
      },
      mapToolResultToToolResultBlockParam: (data: string, id: string) => ({ type: 'tool_result', tool_use_id: id, content: data }),
    }
    let appState = getDefaultAppState()
    const context = {
      abortController: new AbortController(),
      options: { commands: [], tools: [tool], mainLoopModel: 'claude-fable-5-1', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
      getAppState: () => appState,
      setAppState: (update: (prev: typeof appState) => typeof appState) => { appState = update(appState) },
      messages: [],
      readFileState: createFileStateCacheWithSizeLimit(100),
      setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
    }
    const blocks = Array.from({ length: count }, (_, index) => ({ type: 'tool_use', id: `call-${safe}-${index}`, name: tool.name, input: { text: String(index) } }))
    const parent = createAssistantMessage({ content: blocks as never })
    const allow = async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'fixture' } })
    const results: Array<{ tool_use_id: string; is_error?: boolean }> = []
    for await (const update of runTools(blocks as never, [parent], allow as never, context as never)) {
      const message = update.message
      if (message?.type === 'user' && Array.isArray(message.message.content)) {
        results.push(...message.message.content.filter(block => block.type === 'tool_result') as typeof results)
      }
    }
    const elapsed = spans.length ? Math.max(...spans.map(span => span.end)) - Math.min(...spans.map(span => span.start)) : 0
    const shortest = spans.length ? Math.min(...spans.map(span => span.end - span.start)) : 0
    const detail = JSON.stringify({ count: spans.length, peak, elapsed, shortest })
    check(`${safe ? 'safe' : 'unsafe'}: every call executes and settles exactly once`, spans.length === count && results.length === count && blocks.every(block => results.filter(result => result.tool_use_id === block.id && !result.is_error).length === 1), detail)
    if (safe) {
      check('five safe calls overlap rather than serializing', peak >= 2 && elapsed < shortest * 2, detail)
    } else {
      check('three unsafe calls never overlap', peak === 1 && spans.every((span, index) => index === 0 || span.start >= spans[index - 1]!.end), detail)
      check('three unsafe calls retain each full wait', shortest >= delay - 1 && elapsed >= delay * count - count, detail)
    }
  }
} finally {
  clearTimeout(watchdog)
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
