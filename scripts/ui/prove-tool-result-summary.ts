#!/usr/bin/env bun
import { summarizeToolResult, MAX_INLINE_SUMMARY } from '../../src/tools/kit/toolResultSummary.js'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    fail = 1
    console.log('  summarizeToolResult in src/tools/kit/toolResultSummary.ts returned something other than the value named in this check; change the rule for that tool or MAX_INLINE_SUMMARY there.')
  }
}

const bash = (over: Record<string, unknown> = {}) => ({
  stdout: 'hi', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, ...over,
})
t('bash single line inlines', summarizeToolResult('Bash', bash()) === 'hi')
t('bash empty stdout → null (exit-code semantics live downstream)', summarizeToolResult('Bash', bash({ stdout: '  ' })) === null)
t('bash multiline → null', summarizeToolResult('Bash', bash({ stdout: 'a\nb' })) === null)
t('bash stderr → null', summarizeToolResult('Bash', bash({ stderr: 'boom' })) === null)
t('bash interrupted → null', summarizeToolResult('Bash', bash({ interrupted: true })) === null)
t('bash image → null', summarizeToolResult('Bash', bash({ isImage: true })) === null)
t('bash persisted → null', summarizeToolResult('Bash', bash({ persistedOutputPath: '/x' })) === null)
t('bash background → null', summarizeToolResult('Bash', bash({ backgroundTaskId: 'b1' })) === null)
t('bash over-length → null', summarizeToolResult('Bash', bash({ stdout: 'x'.repeat(MAX_INLINE_SUMMARY + 1) })) === null)

t('read text → Read N lines',
  summarizeToolResult('Read', { type: 'text', file: { filePath: '/x', content: 'a', numLines: 317 } }) === 'Read 317 lines')
t('read 1 line singular',
  summarizeToolResult('Read', { type: 'text', file: { numLines: 1 } }) === 'Read 1 line')
t('read image', summarizeToolResult('Read', { type: 'image', file: {} }) === 'Read image')
t('read unchanged', summarizeToolResult('Read', { type: 'file_unchanged', file: {} }) === 'Unchanged since last read')
t('read corrupt (no numLines) → null', summarizeToolResult('Read', { type: 'text', file: {} }) === null)

t('grep content → Found N lines (mirrors the real renderer)',
  summarizeToolResult('Grep', { mode: 'content', numFiles: 2, filenames: [], numLines: 7 }) === 'Found 7 lines')
t('grep count → Found N matches',
  summarizeToolResult('Grep', { mode: 'count', numFiles: 2, filenames: [], numMatches: 9 }) === 'Found 9 matches')
t('grep files mode → Found N files',
  summarizeToolResult('Grep', { mode: 'files_with_matches', numFiles: 3, filenames: [] }) === 'Found 3 files')
t('glob → Found N files',
  summarizeToolResult('Glob', { durationMs: 4, numFiles: 12, filenames: [], truncated: false }) === 'Found 12 files')
t('glob truncated → plain count (renderer never marks truncation)',
  summarizeToolResult('Glob', { durationMs: 4, numFiles: 100, filenames: [], truncated: true }) === 'Found 100 files')
t('read notebook 0 cells → null (error shape downstream)',
  summarizeToolResult('Read', { type: 'notebook', file: { cells: [] } }) === null)
t('bash CJK width over budget → null',
  summarizeToolResult('Bash', bash({ stdout: '中'.repeat(40) })) === null)

t('unknown tool → null', summarizeToolResult('Edit', { filePath: '/x' }) === null)
t('error-string result (never a summary)', summarizeToolResult('Bash', 'Error: boom') === null)
t('null result → null', summarizeToolResult('Bash', null) === null)

t('agent record → null (usage stays off the inline seam)',
  summarizeToolResult('Crewmate', { status: 'completed', totalTokens: 45230, totalToolUseCount: 12, totalDurationMs: 60000, content: [] }) === null)
t('agent record with unreported usage → null (never a fabricated 0)',
  summarizeToolResult('Crewmate', { status: 'completed', totalTokens: 0, totalToolUseCount: 7, totalDurationMs: 42000, content: [] }) === null)
t('wire {} placeholder → null', summarizeToolResult('Read', {}) === null)

const BOARD_REASON = 'An answer names an ask or your own earlier post with replyTo.'
t('CrewBoard refused post → · not posted',
  summarizeToolResult('CrewBoard', { ok: false, reason: BOARD_REASON }, { op: 'post' }) === '· not posted')
t('CrewBoard refused read → · not read',
  summarizeToolResult('CrewBoard', { ok: false, reason: 'This seat is not on the live crew board.' }, { op: 'read' }) === '· not read')
t('CrewBoard refused swarm_team → · not assigned',
  summarizeToolResult('CrewBoard', { ok: false, reason: 'swarm_team needs seat and team.' }, { op: 'swarm_team' }) === '· not assigned')
t('CrewBoard refused swarm_captain → · not assigned',
  summarizeToolResult('CrewBoard', { ok: false, reason: 'swarm_captain needs seat and team.' }, { op: 'swarm_captain' }) === '· not assigned')
t('CrewBoard accepted post → null',
  summarizeToolResult('CrewBoard', { ok: true, eventId: 'e1', seq: 1 }, { op: 'post' }) === null)
t('CrewBoard read result → null',
  summarizeToolResult('CrewBoard', { events: [] }, { op: 'read' }) === null)

{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const scratch = mkdtempSync(join(tmpdir(), 'tool-result-summary-'))
  process.env.MERCURY_CONFIG_DIR = scratch
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
  enableConfigs()
  const React = (await import('react')).default
  const { Box } = await import('../../src/screen/themedRenderer.js')
  const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
  const { AssistantToolUseMessage } = await import('../../src/screen/messages/AssistantToolUseMessage.js')
  const { UserToolSuccessMessage } = await import('../../src/screen/messages/user-tool-result/UserToolSuccessMessage.js')
  const { swarmCensusTool } = await import('../../src/crew/board/seam.js')
  const boardTool = swarmCensusTool()
  const toolUseID = 'toolu_board_refused_1'
  const input = { op: 'post', kind: 'answer', text: 'hi', clientOpId: 'c1' }
  const toolUseBlock = { type: 'tool_use' as const, id: toolUseID, name: 'CrewBoard', input }
  const toolUseResult = { ok: false, reason: BOARD_REASON }
  const userMessage = {
    type: 'user' as const,
    uuid: 'u-board-1',
    timestamp: new Date(0).toISOString(),
    message: {
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: toolUseID, content: JSON.stringify(toolUseResult) }],
    },
    toolUseResult,
  }
  const lookups = {
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
    toolResultByToolUseID: new Map([[toolUseID, userMessage]]),
    toolUseByToolUseID: new Map([[toolUseID, toolUseBlock]]),
    normalizedMessageCount: 2,
    resolvedToolUseIDs: new Set([toolUseID]),
    erroredToolUseIDs: new Set<string>(),
    deniedToolUseIDs: new Set<string>(),
  }
  const renderPair = async (opts: { verbose: boolean; isTranscriptMode?: boolean }): Promise<string[]> => {
    const node = React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(AssistantToolUseMessage as never, {
        param: toolUseBlock,
        tools: [boardTool],
        verbose: opts.verbose,
        isTranscriptMode: opts.isTranscriptMode,
        inProgressToolUseIDs: new Set<string>(),
        lookups: lookups as never,
      } as never),
      React.createElement(UserToolSuccessMessage as never, {
        message: userMessage,
        lookups: lookups as never,
        toolUseID,
        progressMessagesForMessage: [],
        tool: boardTool,
        tools: [boardTool],
        verbose: opts.verbose,
        width: 100,
        isTranscriptMode: opts.isTranscriptMode,
      } as never),
    )
    const out = await renderToString(node as never, 100)
    return out.split('\n').filter(line => line.trim() !== '')
  }
  const compact = await renderPair({ verbose: false })
  t(
    'refused CrewBoard post paints ONE row with CrewBoard, post, · not posted and no reason line',
    compact.length === 1 &&
      compact[0]!.includes('CrewBoard') &&
      compact[0]!.includes('post') &&
      compact[0]!.includes('· not posted') &&
      !compact.some(line => line.includes('An answer names')),
    JSON.stringify(compact),
  )
  const transcript = await renderPair({ verbose: false, isTranscriptMode: true })
  t(
    'refused CrewBoard post in transcript mode keeps the reason line',
    transcript.some(line => line.includes('An answer names')),
    JSON.stringify(transcript),
  )

  const { z } = await import('zod/v4')
  const { runToolUse } = await import('../../src/engine/tool-dispatch/toolExecution.js')
  const { getEmptyToolPermissionContext, buildTool } = await import('../../src/tools/kit/tool.js')
  const { formatZodValidationError } = await import('../../src/tools/kit/toolErrors.js')
  const { UserToolErrorMessage } = await import('../../src/screen/messages/user-tool-result/UserToolErrorMessage.js')
  const schema = z.object({ count: z.number() })
  const probeTool = buildTool({
    name: 'SchemaProbe',
    inputSchema: schema,
    maxResultSizeChars: 1000,
    description: async () => 'probe',
    prompt: async () => 'probe',
    call: async () => ({ data: 'unexpected' }),
    mapToolResultToToolResultBlockParam: (data, toolUseId) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
    renderToolUseMessage: (v: { count: number }) => String(v.count),
  })
  const badInput = { count: 'two' }
  const parsedBad = schema.safeParse(badInput)
  const expectedBuilt = parsedBad.success ? '' : formatZodValidationError(probeTool.name, parsedBad.error)
  const appState = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }
  const updates = []
  for await (const update of runToolUse(
    { type: 'tool_use', id: 'toolu_schema_1', name: probeTool.name, input: badInput },
    { uuid: 'a-schema-1', message: { id: 'm-schema-1' } } as never,
    (async () => ({ behavior: 'allow' })) as never,
    {
      abortController: new AbortController(),
      getAppState: () => appState,
      setAppState: () => {},
      messages: [],
      toolDecisions: new Map(),
      options: { tools: [probeTool], mcpClients: [], isNonInteractiveSession: true },
    } as never,
  )) {
    updates.push(update)
  }
  const errMsg = updates.find(u => u.message.type === 'user')!.message
  const errBlock =
    errMsg.type === 'user' && Array.isArray(errMsg.message.content)
      ? errMsg.message.content.find(b => b.type === 'tool_result')
      : undefined
  const modelContent = typeof errBlock?.content === 'string' ? errBlock.content : ''
  t(
    'schema refusal tool_result content for the model is byte-equal to formatZodValidationError output',
    modelContent === `<tool_use_error>${expectedBuilt}</tool_use_error>` &&
      errMsg.type === 'user' &&
      errMsg.toolUseResult === expectedBuilt,
    JSON.stringify({ modelContent, expectedBuilt }),
  )
  const schemaToolUseBlock = { type: 'tool_use' as const, id: 'toolu_schema_1', name: probeTool.name, input: badInput }
  const schemaLookups = {
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
    toolResultByToolUseID: new Map([['toolu_schema_1', errMsg]]),
    toolUseByToolUseID: new Map([['toolu_schema_1', schemaToolUseBlock]]),
    normalizedMessageCount: 2,
    resolvedToolUseIDs: new Set(['toolu_schema_1']),
    erroredToolUseIDs: new Set(['toolu_schema_1']),
    deniedToolUseIDs: new Set<string>(),
  }
  const renderSchemaPair = async (opts: { verbose: boolean; isTranscriptMode?: boolean }): Promise<string[]> => {
    const node = React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(AssistantToolUseMessage as never, {
        param: schemaToolUseBlock,
        tools: [probeTool],
        verbose: opts.verbose,
        isTranscriptMode: opts.isTranscriptMode,
        inProgressToolUseIDs: new Set<string>(),
        lookups: schemaLookups as never,
      } as never),
      React.createElement(UserToolErrorMessage as never, {
        param: errBlock,
        toolUseResult: errMsg.type === 'user' ? errMsg.toolUseResult : undefined,
        progressMessagesForMessage: [],
        tool: probeTool,
        tools: [probeTool],
        verbose: opts.verbose,
        isTranscriptMode: opts.isTranscriptMode,
        input: badInput,
      } as never),
    )
    const out = await renderToString(node as never, 100)
    return out.split('\n').filter(line => line.trim() !== '')
  }
  const schemaCompact = await renderSchemaPair({ verbose: false })
  t(
    'schema refusal paints ONE row with tool name and · invalid input, and no failed (issue line',
    schemaCompact.length === 1 &&
      schemaCompact[0]!.includes(probeTool.name) &&
      schemaCompact[0]!.includes(' · invalid input') &&
      !schemaCompact.some(line => line.includes('failed (issue')),
    JSON.stringify(schemaCompact),
  )
  const schemaTranscript = await renderSchemaPair({ verbose: false, isTranscriptMode: true })
  t(
    'schema refusal in transcript mode keeps the full refusal',
    schemaTranscript.some(line => line.includes('failed (issue')),
    JSON.stringify(schemaTranscript),
  )
  const schemaVerbose = await renderSchemaPair({ verbose: true })
  t(
    'schema refusal in verbose mode keeps the full refusal',
    schemaVerbose.some(line => line.includes('failed (issue')),
    JSON.stringify(schemaVerbose),
  )
  const ordinaryErrBlock = {
    type: 'tool_result' as const,
    tool_use_id: 'toolu_ordinary_1',
    content: '<tool_use_error>File does not exist.</tool_use_error>',
    is_error: true,
  }
  const ordinaryErrMsg = {
    type: 'user' as const,
    uuid: 'u-ordinary-1',
    timestamp: new Date(0).toISOString(),
    message: { role: 'user' as const, content: [ordinaryErrBlock] },
    toolUseResult: 'File does not exist.',
  }
  const ordinaryToolUse = { type: 'tool_use' as const, id: 'toolu_ordinary_1', name: probeTool.name, input: { count: 3 } }
  const ordinaryLookups = {
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
    toolResultByToolUseID: new Map([['toolu_ordinary_1', ordinaryErrMsg]]),
    toolUseByToolUseID: new Map([['toolu_ordinary_1', ordinaryToolUse]]),
    normalizedMessageCount: 2,
    resolvedToolUseIDs: new Set(['toolu_ordinary_1']),
    erroredToolUseIDs: new Set(['toolu_ordinary_1']),
    deniedToolUseIDs: new Set<string>(),
  }
  const ordinaryOut = (
    await renderToString(
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(AssistantToolUseMessage as never, {
          param: ordinaryToolUse,
          tools: [probeTool],
          verbose: false,
          inProgressToolUseIDs: new Set<string>(),
          lookups: ordinaryLookups as never,
        } as never),
        React.createElement(UserToolErrorMessage as never, {
          param: ordinaryErrBlock,
          toolUseResult: ordinaryErrMsg.toolUseResult,
          progressMessagesForMessage: [],
          tool: probeTool,
          tools: [probeTool],
          verbose: false,
          input: { count: 3 },
        } as never),
      ) as never,
      100,
    )
  )
    .split('\n')
    .filter(line => line.trim() !== '')
  t(
    'ordinary tool error keeps its error row and never appends · invalid input',
    ordinaryOut.some(line => line.includes('File does not exist.')) &&
      !ordinaryOut.some(line => line.includes('invalid input')),
    JSON.stringify(ordinaryOut),
  )
  rmSync(scratch, { recursive: true, force: true })
}

console.log(fail ? '❌ TOOL-RESULT-SUMMARY RED' : '✅ TOOL-RESULT-SUMMARY GREEN')
process.exit(fail)
