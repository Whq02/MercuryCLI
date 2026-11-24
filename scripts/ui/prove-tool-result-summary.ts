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
  rmSync(scratch, { recursive: true, force: true })
}

console.log(fail ? '❌ TOOL-RESULT-SUMMARY RED' : '✅ TOOL-RESULT-SUMMARY GREEN')
process.exit(fail)
