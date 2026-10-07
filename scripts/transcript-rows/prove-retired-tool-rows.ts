#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILE_TOOL_SPELLINGS } from '../identity/forbidden-file-tool.ts'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'retired-tool-rows-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { AssistantToolUseMessage } = await import('../../src/components/messages/AssistantToolUseMessage.js')
const { findToolForRender } = await import('../../src/tools/MCPTool/absentToolShim.js')
const { getAllBaseTools, getTools } = await import('../../src/tools.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
function check(cond: boolean, label: string, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

type OldRow = { id: string; name: string; spelling?: 'alias'; input: Record<string, unknown>; nameShape: RegExp; carries: string }

function lookupsFor(id: string): unknown {
  return {
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
    toolResultByToolUseID: new Map(),
    toolUseByToolUseID: new Map(),
    normalizedMessageCount: 1,
    resolvedToolUseIDs: new Set([id]),
    erroredToolUseIDs: new Set(),
    deniedToolUseIDs: new Set(),
  }
}

async function renderOldRow(row: OldRow, tools: unknown): Promise<string[]> {
  const node = React.createElement(AssistantToolUseMessage as never, {
    param: { type: 'tool_use', id: row.id, name: row.name, input: row.input },
    tools,
    verbose: true,
    inProgressToolUseIDs: new Set<string>(),
    lookups: lookupsFor(row.id) as never,
  } as never)
  const out = await renderToString(node as never, 120)
  return out.split('\n').filter(line => line.trim() !== '')
}

const FILE_ROW: OldRow = { id: 'toolu_old_file', name: FILE_TOOL_SPELLINGS[0], input: { files: ['/proof/report.pdf'], status: 'normal' }, nameShape: new RegExp(FILE_TOOL_SPELLINGS[0]), carries: 'report.pdf' }
const CATALOGUE_ROWS: OldRow[] = [
  FILE_ROW,
  { id: 'toolu_old_to', name: 'TaskOutput', input: { task_id: 'b7x2', block: true, timeout: 30000 }, nameShape: /Task ?Output/, carries: 'b7x2' },
  { id: 'toolu_old_bo', name: 'BashOutputTool', spelling: 'alias', input: { task_id: 'b1' }, nameShape: /(?:Task|Bash) ?Output/, carries: 'b1' },
]
const SESSION_POOL_ROWS: OldRow[] = [
  FILE_ROW,
  { id: 'toolu_old_sum', name: 'SendUserMessage', input: { message: 'the old reply', status: 'normal' }, nameShape: /SendUserMessage/, carries: 'the old reply' },
  { id: 'toolu_old_br', name: 'Brief', spelling: 'alias', input: { message: 'the older reply' }, nameShape: /\bBrief\b/, carries: 'the older reply' },
]

console.log('retired tool rows — an old transcript row still draws after its tool left the roster')

const catalogue = getAllBaseTools()
for (const row of CATALOGUE_ROWS) {
  const resolved = findToolForRender(catalogue as never, row.name)
  if (row.spelling !== 'alias') check(resolved.name === row.name, `${row.name}: the render lookup resolves the recorded name`, resolved.name)
  const lines = await renderOldRow(row, catalogue)
  const text = lines.join('\n')
  check(lines.length >= 1, `${row.name}: the old row draws at least one line`, JSON.stringify(lines))
  check(row.nameShape.test(text), `${row.name}: the row names the tool`, text)
  check(text.includes(row.carries), `${row.name}: the row carries the recorded input`, text)
}

const sessionPool = getTools({ ...getEmptyToolPermissionContext(), mode: 'default' } as never)
for (const row of SESSION_POOL_ROWS) {
  const resolved = findToolForRender(sessionPool as never, row.name)
  if (row.spelling !== 'alias') check(resolved.name === row.name, `${row.name}: the render lookup resolves the recorded name`, resolved.name)
  const lines = await renderOldRow(row, sessionPool)
  const text = lines.join('\n')
  check(lines.length >= 1, `${row.name}: the old row draws at least one line`, JSON.stringify(lines))
  check(row.nameShape.test(text), `${row.name}: the row names the tool`, text)
  check(text.includes(row.carries), `${row.name}: the row carries the recorded input`, text)
}

console.log(failures === 0 ? 'retired tool rows: ALL GREEN' : `retired tool rows: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
