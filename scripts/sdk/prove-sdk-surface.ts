import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as sdk from '../../sdk/src/index.ts'
import { startFixtureServer } from '../../sdk/src/testing.ts'

export function example(schema: any): any {
  if (schema.const !== undefined) return schema.const
  if (schema.enum) return schema.enum[0]
  if (schema.oneOf || schema.anyOf) return example((schema.oneOf || schema.anyOf)[0])
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  if (type === 'object') return Object.fromEntries((schema.required ?? []).map((key: string) => [key, example(schema.properties[key])]))
  if (type === 'array') return []
  if (type === 'string') return 'x'.repeat(schema.minLength ?? 1)
  if (type === 'boolean') return false
  if (type === 'null') return null
  if (type === 'number' || type === 'integer') return Math.max(schema.minimum ?? 0, (schema.exclusiveMinimum ?? -1) + 1)
  return null
}
const rows = Object.values(sdk.ROW_SCHEMAS).map(example)
for (const row of rows) {
  const read = sdk.parseRow(JSON.stringify(row))
  assert.equal(read.ok, true, JSON.stringify(read))
  assert.deepEqual(read.ok && read.row, row)
}
const future = { type: 'future_feature', payload: { untouched: [1, 2] } }
assert.equal(sdk.rowOf(future).ok, true)
const outcome = { ...rows.find(r => r.type === 'outcome'), status: 'completed', answer: 'fixture answer' }
const session = rows.find(r => r.type === 'session')
const fixture = await startFixtureServer({ rows: [session, future, outcome], inputCount: 3 })
try {
  const run = sdk.run({ mercury: fixture.mercury, input: 'rows' })
  let unknown: unknown
  run.on('unknown_row', row => { unknown = row.raw })
  await run.sendPrompt('hello')
  await run.sendShell('echo hello')
  await run.sendNote('agent', 'hello')
  run.closeInput()
  assert.equal((await run.outcome).answer, 'fixture answer')
  assert.deepEqual(unknown, future)
  assert.deepEqual(fixture.received.map(r => r.type), ['prompt', 'shell', 'note'])
} finally { await fixture.close() }

const permission = { jsonrpc: '2.0', id: 901, method: 'permission/request', params: { kind: 'tool', tool_use_id: 'call', tool_name: 'Read', input: {} } }
const methods: Record<string, any[]> = Object.fromEntries(Object.entries(sdk.METHODS).filter(([, s]) => s.from === 'host' && s.kind === 'request').map(([name, s]) => [name, [{ result: example(s.result) }]]))
methods.initialize = [{ result: { protocol: 1, runner: { version: 'fixture', pid: 1 }, session_id: 'fixture' } }]
methods['queue/add'] = [{ result: { accepted: true }, after: [permission] }]
const rpc = await startFixtureServer({ methods, answers: { '901': [{ jsonrpc: '2.0', method: 'row', params: future }, { jsonrpc: '2.0', method: 'row', params: outcome }] } })
try {
  let askSeen = false
  const s = await sdk.connect({ mercury: rpc.mercury, onPermissionRequest: async ask => { askSeen = ask.tool_name === 'Read'; return { outcome: 'deny', message: 'fixture policy' } } })
  try {
    const result = await s.prompt('hello')
    assert.equal(result.status, 'completed')
    assert.equal(askSeen, true)
    assert(s.rows.some(r => r.type === 'unknown_row'))
    for (const [name, spec] of Object.entries(sdk.METHODS)) {
      if (spec.from !== 'host' || spec.kind !== 'request' || ['initialize', 'queue/add'].includes(name)) continue
      assert.deepEqual(await s.request(name as sdk.HostRequestName, example(spec.params)), example(spec.result), name)
    }
    assert(rpc.received.some(r => r.id === 901 && (r.result as any)?.outcome === 'deny'))
  } finally { await s.close() }
} finally { await rpc.close() }

const tools = await sdk.serveTools([sdk.defineTool({ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, execute: (input: { text: string }) => input.text })])
try {
  const response = await fetch(tools.config.url, { method: 'POST', headers: { ...tools.config.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'from inline tool' } } }) })
  assert.equal((await response.json() as any).result.content[0].text, 'from inline tool')
  assert.equal((await fetch(tools.config.url, { method: 'POST', body: '{}' })).status, 403)
} finally { await tools.close() }
assert.equal(sdk.defineAgent({ description: 'reader', prompt: 'read only' }).prompt, 'read only')

const scratch = mkdtempSync(join(tmpdir(), 'sdk-surface-'))
try {
  writeFileSync(join(scratch, 'fixture.json'), JSON.stringify({ rows, outcome, session, future, methods }))
  const root = resolve(import.meta.dir, '../..')
  const child = spawn('python3', [join(root, 'scripts/sdk/python-surface.py'), join(scratch, 'fixture.json')], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(root, 'sdk-py/src') }, stdio: 'inherit' })
  const code = await new Promise<number | null>(r => child.on('close', r))
  assert.equal(code, 0)
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log('PASS SDK surface: 25 row types, unknown rows, both replay servers, streaming input, every host request, host permission, inline tool, sync Python')
