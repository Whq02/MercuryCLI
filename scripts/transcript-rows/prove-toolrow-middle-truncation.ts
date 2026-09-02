#!/usr/bin/env bun
// ============================================================================
//  scripts/transcript-rows/prove-toolrow-middle-truncation.ts
//  PROOF: the tool-row truncation law — a long target keeps the row ONE
//  line with a MIDDLE-anchored cut, so the head (mark + tool name + the
//  path's leading directories) and the tail (the filename) both survive.
//  Driven on the REAL AssistantToolUseMessage with the REAL FileReadTool
//  at several widths (the law must be width-aware, not an 80-column
//  constant); the short-path control renders whole, ellipsis-free.
//
//  Run:  ~/.bun/bin/bun run scripts/transcript-rows/prove-toolrow-middle-truncation.ts
// ============================================================================

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Sandbox before src imports (token/theme reads resolve the config home).
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'toolrow-trunc-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { AssistantToolUseMessage } = await import(
  '../../src/components/messages/AssistantToolUseMessage.js'
)
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.js')

let failures = 0
function check(cond: boolean, label: string, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

const TOOL_USE_ID = 'toolu_trunc_01'

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
    tools: [FileReadTool],
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
  check(lines.length === 1, `width ${columns}: a long path keeps the row to ONE line`, `${lines.length} lines: ${JSON.stringify(lines)}`)
  const row = lines[0] ?? ''
  check(row.includes('…'), `width ${columns}: the overflow cut is marked with an ellipsis`, row)
  check(row.includes('Read'), `width ${columns}: the head keeps the tool name`, row)
  check(row.includes('the-load-bearing-filename.ts'), `width ${columns}: the tail keeps the FILENAME`, row)
  check(row.includes('/scratch/'), `width ${columns}: the head keeps the path's leading directories`, row)
}

// The control: a short path renders whole — no cut at all.
{
  const lines = await renderRow('/scratch/notes.md', 80)
  const row = lines[0] ?? ''
  check(lines.length === 1 && row.includes('/scratch/notes.md') && !row.includes('…'), 'a short path renders whole, ellipsis-free', JSON.stringify(lines))
}

console.log(failures === 0 ? '✅ tool-row middle-truncation law holds' : `❌ ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
