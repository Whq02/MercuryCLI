import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mock, setSystemTime } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
setSystemTime(new Date('2026-10-07T12:00:00.000Z'))

const root = join(import.meta.dir, '..', '..')
const fixture = join(import.meta.dir, 'fixtures', 'definition-corpus.json')
const model = 'gpt-6-astra'
const record = process.argv.includes('--record')
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
type Corpus = { base: string; model: string; definitions: unknown[] }
const recorded: Corpus | null = existsSync(fixture) ? (JSON.parse(readFileSync(fixture, 'utf8')) as Corpus) : null

if (record) {
  assert.equal(git('diff', '--name-only', 'HEAD', '--', 'src'), '', 'record from a committed product tree')
} else {
  assert.notEqual(recorded, null, 'the corpus is recorded (bun scripts/tool-economy/prove-definition-corpus-parity.ts --record)')
}
const base = record ? git('rev-parse', 'HEAD') : (recorded as Corpus).base

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const interpreters = await import('../../src/services/eval/interpreters.ts')
mock.module('../../src/services/eval/interpreters.js', () => ({
  ...interpreters,
  primeEvalAvailability: async () => [
    { language: 'py', available: true, interpreterPath: 'python3', version: 'Python 3.14.7' },
    { language: 'js', available: true, interpreterPath: 'node', version: 'v24.21.0' },
  ],
}))
const { getAllBaseTools } = await import('../../src/tools.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const tools = getAllBaseTools().filter(tool => tool.name !== ComputerTool.name)
const browserIndex = tools.findIndex(tool => tool.name === 'Browser')
assert.notEqual(browserIndex, -1, 'the corpus has its desktop insertion point')
tools.splice(browserIndex + 1, 0, ComputerTool)
assert.equal(tools.length, 58, 'the corpus covers all 58 base catalogue entries')
assert.equal(new Set(tools.map(tool => tool.name)).size, 58, 'every definition has a distinct name')
const permissionContext = getEmptyToolPermissionContext()
const definitions = []
for (const tool of tools) {
  definitions.push(await toolToAPISchema(tool, {
    getToolPermissionContext: async () => permissionContext,
    tools,
    agents: [],
    model,
  }))
}
const bytes = JSON.stringify({ base, model, definitions }, null, 2) + '\n'
if (record) {
  writeFileSync(fixture, bytes)
  console.log(`RECORDED 58 definitions at ${base}`)
}
const moved = tools
  .map((tool, i) => (JSON.stringify(definitions[i]) === JSON.stringify((recorded ?? { definitions }).definitions[i]) ? null : tool.name))
  .filter((name): name is string => name !== null)
if (record) console.log(moved.length === 0 ? 'no definition moved since the previous recording' : `moved since the previous recording (list the diff in the fold log): ${moved.join(', ')}`)
else assert.deepEqual(moved, [], `a definition moved since the recording at ${base} — re-record with --record and list the diff: ${moved.join(', ')}`)
assert.equal(bytes, readFileSync(fixture, 'utf8'), 'every definition remains byte-identical in catalogue order')
console.log(`PASS CORPUS 58 definitions identical; ${Buffer.byteLength(bytes)} bytes; sha256 ${createHash('sha256').update(bytes).digest('hex')}`)
