#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'loaded-tool-preferences-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ fixture: { command: 'true', args: [], connect: 'stdio' } })
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getAllBaseTools } = await import('../../src/tools.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const pool = getAllBaseTools()
const wanted: Array<[string, RegExp]> = [
  ['ChangeSet', /^Applies one set of edits, moves and deletions across existing text files as a whole:[\s\S]*every member is checked against its read anchor before the first write and one operator decision covers the set; a drifted or invalid member refuses the whole set and nothing is written\./],
  ['AstSearch', /over Grep[\s\S]*shape/],
  ['AstEdit', /over Edit[\s\S]*every match/],
  ['LspRead', /^Read-only language-server queries; prefer over text search for symbols/],
  ['Test', /^Prefer this to Bash for structured test results, exact failure reruns and durable records/],
  ['Git', /^Inspect local repositories[\s\S]*preview and apply commit groups/],
  ['Debug', /(?:over|instead of) print debugging/],
  ['Monitor', /over polling a log/],
  ['Checkpoint', /detour[\s\S]*keep in context/],
  ['Rewind', /detour[\s\S]*keep in context/],
]
let failures = 0
for (const [name, comparison] of wanted) {
  const tool = pool.find(t => t.name === name)
  const schema = tool && await toolToAPISchema(tool, { tools: pool, agents: [], getToolPermissionContext: async () => getEmptyToolPermissionContext(), model: 'claude-sonnet-5' })
  const description = schema?.description ?? ''
  const ok = typeof description === 'string' && comparison.test(description)
    && (name !== 'ChangeSet' || (Buffer.byteLength(description) <= 550 && !/\bEdit\b|\bprefer\b|\n\n/.test(description)))
  if (!ok) failures++
  const fact = name === 'ChangeSet' ? 'one atomic-set paragraph, no tool comparison, at most 550 bytes' : 'the wire description says when to prefer it'
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}: ${fact} — ${Buffer.byteLength(String(description))} description bytes`)
}
process.exit(failures === 0 ? 0 : 1)
