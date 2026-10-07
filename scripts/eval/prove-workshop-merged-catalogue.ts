import { mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { deepStrictEqual } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, cleanup, finish, setup } from './lib.js'
import { CODE_TOOL_SPELLINGS } from '../identity/forbidden-code-tool.js'

setup()
const original = await import('../../src/services/eval/interpreters.js')
const availability = [
  { language: 'py', available: true, version: 'Python 3.13.13', interpreterPath: 'python3' },
  { language: 'js', available: true, version: 'v24.20.0', interpreterPath: 'node' },
]
mock.module('../../src/services/eval/interpreters.js', () => ({ ...original, evalAvailability: () => availability, primeEvalAvailability: async () => availability }))
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.js')
const { getAllBaseTools } = await import('../../src/tools.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { toolToAPISchema } = await import('../../src/utils/api.js')
const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.js')
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.js')
const expected = {
  type: 'object', properties: {
    language: { type: 'string', enum: ['py', 'js'], description: 'The retained runtime this cell runs in.' },
    code: { type: 'string', minLength: 1, description: 'The cell source. State persists to your next cell in this language.' },
    title: { description: 'Short human title for the cell card.', type: 'string' },
    timeoutSeconds: { description: 'Runtime budget in seconds: default 30, at most 600 (a larger value runs at 600 and the result says so); 0 disables; bridge and permission time never counts.', type: 'integer', minimum: 0, maximum: 9007199254740991 },
    reset: { description: "Recreate this language's kernel first (the other language keeps its state).", type: 'boolean' },
  }, required: ['language', 'code'], additionalProperties: false,
}
const options = { tools: [EvalTool, { name: 'Inspect' }] as never, agents: [], getToolPermissionContext: async () => getEmptyToolPermissionContext() }
for (const [enabled, hash, bytes] of [
  ['1', 'e33c45fe5ebc068ff4be1bea59581073c89afa87375b39cf63e6fecfb0a62e69', 5254],
  ['0', '020ffa6729adc40fdaffaef94538d8ef9654d140ff75c2113869e6f551a7cb51', 4824],
] as const) {
  process.env.MERCURY_SAMPLES = enabled
  clearToolSchemaCache()
  const definition = await toolToAPISchema(EvalTool, options) as any
  check(`samples=${enabled}: complete description matches the specification`, createHash('sha256').update(definition.description).digest('hex') === hash, definition.description)
  let same = true
  try { deepStrictEqual(definition.input_schema, expected) } catch { same = false }
  check('five-field wire schema matches exactly', same, JSON.stringify(definition.input_schema))
  const wire = JSON.stringify({ ...definition, eager_input_streaming: true })
  check(`samples=${enabled}: compact definition with eager_input_streaming is ${bytes} bytes`, Buffer.byteLength(wire) === bytes, String(Buffer.byteLength(wire)))
}
const noInspect = await EvalTool.prompt({ ...options, tools: [EvalTool] })
check('Inspect is named only when available in the session pool', !noInspect.includes('tool.Inspect({ref})'))
check('the tool remains loaded in full', EvalTool.shouldDefer !== true)
if (!process.argv.includes('--contract-only')) {
  const names = getAllBaseTools().map(tool => tool.name)
  check('the catalogue has only the retained code tool', names.includes('Eval') && !names.includes(CODE_TOOL_SPELLINGS[0]))
  check('the retired runtime gate no longer exists', !FLAG_REGISTRY.some(flag => flag.env === CODE_TOOL_SPELLINGS[1]))
  const roster = readFileSync(join(import.meta.dir, '../../src/tools.ts'), 'utf8')
  check('the roster imports no retired runtime', !roster.includes(CODE_TOOL_SPELLINGS[0]) && !roster.includes(CODE_TOOL_SPELLINGS[0].toLowerCase()))
}
cleanup()
finish('EVAL SINGLE RUNTIME CATALOGUE')
