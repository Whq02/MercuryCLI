import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mock, setSystemTime } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

writeFileSync(join(proofHome, 'settings.json'), '{"memory":{"journal":true}}\n')

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL']) delete process.env[k]
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
const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.ts')
const tools = getAllBaseTools().filter(tool => tool.name !== ComputerTool.name && tool.name !== DebugTool.name)
const testIndex = tools.findIndex(tool => tool.name === 'Test')
assert.notEqual(testIndex, -1, 'the corpus has its debugger insertion point')
tools.splice(testIndex, 0, DebugTool)
const browserIndex = tools.findIndex(tool => tool.name === 'Browser')
assert.notEqual(browserIndex, -1, 'the corpus has its desktop insertion point')
tools.splice(browserIndex + 1, 0, ComputerTool)
assert.equal(tools.length, 60, 'the corpus covers all 60 base catalogue entries')
assert.equal(new Set(tools.map(tool => tool.name)).size, 60, 'every definition has a distinct name')
assert.ok(tools.some(tool => tool.name === 'Debug'), 'the corpus covers Debug even when no local adapter resolves')
const permissionContext = getEmptyToolPermissionContext()
const definitions: Array<import('../../src/types/wire.js').ApiTool & { description: string }> = []
for (const tool of tools) {
  const definition = await toolToAPISchema(tool, {
    getToolPermissionContext: async () => permissionContext,
    tools,
    agents: [],
    model,
  })
  assert.ok('description' in definition && typeof definition.description === 'string' && 'input_schema' in definition)
  definitions.push({ ...definition, description: definition.description })
}
const crewPrompt = definitions.find(definition => definition.name === 'Crewmate')!.description
assert.match(crewPrompt, /Implementation briefs carry the known target and acceptance criteria/)
assert.match(crewPrompt, /Investigation briefs carry the unresolved question, evidence already checked, boundaries and required evidence in the answer/)
assert.match(crewPrompt, /Keep ownership of the overall task; delegate reasoning inside a well-scoped question/)
assert.ok(!crewPrompt.includes('Never hand the synthesis'))
const bashDefinition = definitions.find(definition => definition.name === 'Bash')!
assert.equal(bashDefinition.description.split('Use `Test` for typed failures and rerunning only failed tests').length, 2)
const debugDefinition = definitions.find(definition => definition.name === 'Debug')!
assert.match(debugDefinition.description, /depth sets how many, default 20/)
assert.match(debugDefinition.description, /\.mercury\/dap-adapters\.json in the trusted working directory/)
assert.equal((debugDefinition as { input_schema: { properties: { depth: { description: string } } } }).input_schema.properties.depth.description, 'stack: number of frames to return (default 20)')
const computerDefinition = definitions.find(definition => definition.name === 'Computer')!
assert.ok('description' in computerDefinition && typeof computerDefinition.description === 'string')
assert.match(computerDefinition.description, /Call Computer directly, not through Eval\. Coordinates are pixels of its last screenshot; renew after compaction\/frame changes\./)
const bytes = JSON.stringify({ base, model, definitions }, null, 2) + '\n'
if (record) {
  writeFileSync(fixture, bytes)
  console.log(`RECORDED 60 definitions at ${base}`)
}
const previousDefinitions = new Map((recorded ?? { definitions }).definitions.map(definition => [(definition as { name: string }).name, definition]))
const moved = tools
  .map((tool, i) => (JSON.stringify(definitions[i]) === JSON.stringify(previousDefinitions.get(tool.name)) ? null : tool.name))
  .filter((name): name is string => name !== null)
if (record) console.log(moved.length === 0 ? 'no definition moved since the previous recording' : `moved since the previous recording (list the diff in the fold log): ${moved.join(', ')}`)
else assert.deepEqual(moved, [], `a definition moved since the recording at ${base} — re-record with --record and list the diff: ${moved.join(', ')}`)
assert.equal(bytes, readFileSync(fixture, 'utf8'), 'every definition remains byte-identical in catalogue order')
console.log(`PASS CORPUS 60 definitions identical; ${Buffer.byteLength(bytes)} bytes; sha256 ${createHash('sha256').update(bytes).digest('hex')}`)
