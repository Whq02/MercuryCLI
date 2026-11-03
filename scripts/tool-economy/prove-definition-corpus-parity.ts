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
assert.equal(tools.length, 62, 'the corpus covers all 62 base catalogue entries')
assert.equal(new Set(tools.map(tool => tool.name)).size, 62, 'every definition has a distinct name')
assert.ok(tools.some(tool => tool.name === 'Debug'), 'the corpus covers Debug even when no local adapter resolves')
assert.ok(tools.some(tool => tool.name === 'CrewBoard'), 'the default-on board is present in the base catalogue')
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
const crewTool = tools.find(tool => tool.name === 'Crewmate')!
const crewPrompt = await crewTool.prompt({ getToolPermissionContext: async () => permissionContext, tools, agents: [] })
const crewDefinition = definitions.find(definition => definition.name === 'Crewmate')! as { input_schema: { properties: { prompt: { description: string }; model: { description: string } } } }
assert.match(crewDefinition.input_schema.properties.prompt.description, /objective, evidence, boundaries, acceptance criteria and whether to implement or research/)
assert.match(crewDefinition.input_schema.properties.model.description, /never downgrade to obtain read-only scoping/)
assert.ok(!crewPrompt.includes('Never hand the synthesis') && !crewPrompt.includes('## Model selection'))
const bashDefinition = definitions.find(definition => definition.name === 'Bash')!
assert.ok(!bashDefinition.description.includes('Use `Test`') && !/\b(Glob|Grep|Read|Edit|Write|WebFetch|Browser|Service|TaskStop|ToolSearch)\b/.test(bashDefinition.description), 'Bash names no other tool')
const debugDefinition = definitions.find(definition => definition.name === 'Debug')!
const debugManual = await DebugTool.prompt({ getToolPermissionContext: async () => permissionContext, tools, agents: [] })
assert.ok(!/default 20/.test(debugManual), 'the depth default lives in the depth field alone, not in the manual')
assert.ok(!/MERCURY_DAP_ADAPTERS|dap-adapters\.json/.test(debugManual), 'adapter registration is operator documentation, not model text')
assert.equal((debugDefinition as { input_schema: { properties: { depth: { description: string } } } }).input_schema.properties.depth.description, 'stack: number of frames to return (default 20)')
const computerDefinition = definitions.find(definition => definition.name === 'Computer')!
assert.ok('description' in computerDefinition && typeof computerDefinition.description === 'string')
assert.match(computerDefinition.description, /Coordinates are pixels of its last screenshot; refresh after frame changes\./)
assert.ok(!computerDefinition.description.includes('not through Eval'), 'no Eval prohibition: tool.Computer works from a cell')
const bytes = JSON.stringify({ base, model, definitions }, null, 2) + '\n'
if (record) {
  writeFileSync(fixture, bytes)
  console.log(`RECORDED 62 definitions at ${base}`)
}
const previousDefinitions = new Map((recorded ?? { definitions }).definitions.map(definition => [(definition as { name: string }).name, definition]))
const moved = tools
  .map((tool, i) => (JSON.stringify(definitions[i]) === JSON.stringify(previousDefinitions.get(tool.name)) ? null : tool.name))
  .filter((name): name is string => name !== null)
if (record) console.log(moved.length === 0 ? 'no definition moved since the previous recording' : `moved since the previous recording (list the diff in the fold log): ${moved.join(', ')}`)
else assert.deepEqual(moved, [], `a definition moved since the recording at ${base} — re-record with --record and list the diff: ${moved.join(', ')}`)
assert.equal(bytes, readFileSync(fixture, 'utf8'), 'every definition remains byte-identical in catalogue order')
console.log(`PASS CORPUS 62 definitions identical; ${Buffer.byteLength(bytes)} bytes; sha256 ${createHash('sha256').update(bytes).digest('hex')}`)
