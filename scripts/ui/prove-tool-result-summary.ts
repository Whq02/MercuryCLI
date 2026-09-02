#!/usr/bin/env bun
import { summarizeToolResult, MAX_INLINE_SUMMARY } from '../../src/utils/toolResultSummary.js'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
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
  summarizeToolResult('Agent', { status: 'completed', totalTokens: 45230, totalToolUseCount: 12, totalDurationMs: 60000, content: [] }) === null)
t('agent record with unreported usage → null (never a fabricated 0)',
  summarizeToolResult('Agent', { status: 'completed', totalTokens: 0, totalToolUseCount: 7, totalDurationMs: 42000, content: [] }) === null)
t('wire {} placeholder → null', summarizeToolResult('Read', {}) === null)

console.log(fail ? '❌ TOOL-RESULT-SUMMARY RED' : '✅ TOOL-RESULT-SUMMARY GREEN')
process.exit(fail)
