#!/usr/bin/env bun

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'toolrow-trunc-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
const { AssistantToolUseMessage } = await import(
  '../../src/screen/messages/AssistantToolUseMessage.js'
)
const { ReadTool } = await import('../../src/tools/read/ReadTool.js')

let failures = 0
function check(cond: boolean, label: string, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

const TOOL_USE_ID = 'toolu_trunc_01'
const rowWhere = ' | fix the truncate-middle Text of the tool row in src/screen/messages/AssistantToolUseMessage.tsx'

function lookupsFor(): unknown {
  return {
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
    toolResultByToolUseID: new Map(),
    toolUseByToolUseID: new Map(),
    normalizedMessageCount: 1,
    resolvedToolUseIDs: new Set([TOOL_USE_ID]),
    erroredToolUseIDs: new Set(),
    deniedToolUseIDs: new Set(),
  }
}

async function renderRow(filePath: string, columns: number): Promise<string[]> {
  const node = React.createElement(AssistantToolUseMessage as never, {
    param: { type: 'tool_use', id: TOOL_USE_ID, name: 'Read', input: { file_path: filePath } },
    tools: [ReadTool],
    verbose: true,
    inProgressToolUseIDs: new Set<string>(),
    lookups: lookupsFor() as never,
  } as never)
  const out = await renderToString(node as never, columns)
  return out.split('\n').filter(line => line.trim() !== '')
}

const DEEP_DIR = '/scratch/projects/mercury/very/deeply/nested/module/tree/of/directories/that/keeps/going'
const LONG_PATH = `${DEEP_DIR}/the-load-bearing-filename.ts`

console.log('tool-row truncation — one line, middle cut, width-aware')

for (const columns of [60, 80, 120]) {
  const lines = await renderRow(LONG_PATH, columns)
  check(lines.length === 1, `width ${columns}: a long path keeps the row to ONE line`, `${lines.length} lines: ${JSON.stringify(lines)}${rowWhere}`)
  const row = lines[0] ?? ''
  check(row.includes('…'), `width ${columns}: the overflow cut is marked with an ellipsis`, row + rowWhere)
  check(row.includes('Read'), `width ${columns}: the head keeps the tool name`, row + rowWhere)
  check(row.includes('the-load-bearing-filename.ts'), `width ${columns}: the tail keeps the FILENAME`, row + rowWhere)
  check(row.includes('/scratch/'), `width ${columns}: the head keeps the path's leading directories`, row + rowWhere)
}

{
  const lines = await renderRow('/scratch/notes.md', 80)
  const row = lines[0] ?? ''
  check(lines.length === 1 && row.includes('/scratch/notes.md') && !row.includes('…'), 'a short path renders whole, ellipsis-free', JSON.stringify(lines) + rowWhere)
}

console.log(failures === 0 ? '✅ tool-row middle-truncation law holds' : `❌ ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
