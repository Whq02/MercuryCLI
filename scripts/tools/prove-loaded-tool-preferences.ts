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
const lawful = ['ChangeSet', 'Git', 'Test', 'AstSearch', 'AstEdit', 'LspRead', 'Monitor', 'Debug', 'Checkpoint', 'Rewind']
const names = pool.map(tool => tool.name)
const PREFERENCE = /\bprefer\w*\b|\binstead of\b|\brather than\b|\buse this\b/i
let failures = 0
function report(ok: boolean, line: string): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${line}`)
}
async function describe(name: string): Promise<string> {
  const tool = pool.find(t => t.name === name)
  if (!tool) return ''
  const schema = await toolToAPISchema(tool, { tools: pool, agents: [], getToolPermissionContext: async () => getEmptyToolPermissionContext(), model: 'claude-sonnet-5' }) as { description?: unknown }
  return typeof schema.description === 'string' ? schema.description : ''
}
for (const name of lawful) {
  const description = await describe(name)
  const first = description.split(/(?<=\.)\s/)[0] ?? ''
  const others = names.filter(other => other !== name && new RegExp(`\\b${other}\\b`).test(first.replace(/^\w+/, '')))
  report(first.length >= 40 && others.length === 0 && !PREFERENCE.test(first), `${name}: opens with what it does, names no other tool and no preference — "${first.slice(0, 90)}${first.length > 90 ? '…' : ''}" (${Buffer.byteLength(description)} description bytes${others.length ? `; names ${others.join(', ')}` : ''})`)
}
process.exit(failures === 0 ? 0 : 1)
