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
const contracts = await import('../../src/services/eval/contracts.js')
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
for (const [enabled, hash, manualBytes, bytes] of [
  ['1', '863cb65c8d9934e606ba207405886d361a437e0363f7da741dd710fbeb7380af', 7375, 2004],
  ['0', '93123c2a359d87ad856fdd6fa7ed664e019d9e9081d258e0337301a9add6b4d3', 5341, 1962],
] as const) {
  process.env.MERCURY_SAMPLES = enabled
  clearToolSchemaCache()
  const manual = await EvalTool.prompt(options)
  const definition = await toolToAPISchema(EvalTool, options) as any
  check(`samples=${enabled}: the complete manual matches fold 46as bridge accounting with fold 46bc's read_file and Bash helper lines (${manualBytes} bytes)`, createHash('sha256').update(manual).digest('hex') === hash && Buffer.byteLength(manual) === manualBytes, `${Buffer.byteLength(manual)} bytes: ${manual}`)
  check(`samples=${enabled}: the wire carries the Eval wire contract rendered from that manual (fold 46bh), the manual arriving on discovery or first use`, typeof EvalTool.wireDescription === 'function' && definition.description === EvalTool.wireDescription(manual) && definition.description.includes(enabled === '1' ? 'sample publishes only on an operator ask' : 'JS read_file needs await.\n'), definition.description)
  let same = true
  try { deepStrictEqual(definition.input_schema, expected) } catch { same = false }
  check('five-field wire schema matches exactly', same, JSON.stringify(definition.input_schema))
  check(`samples=${enabled}: the timeoutSeconds field names the runtime constants (default ${contracts.EVAL_DEFAULT_TIMEOUT_SECONDS}, at most ${contracts.EVAL_MAX_TIMEOUT_SECONDS}) from contracts.ts`, definition.input_schema.properties.timeoutSeconds.description === `Runtime budget in seconds: default ${contracts.EVAL_DEFAULT_TIMEOUT_SECONDS}, at most ${contracts.EVAL_MAX_TIMEOUT_SECONDS} (a larger value runs at ${contracts.EVAL_MAX_TIMEOUT_SECONDS} and the result says so); 0 disables; bridge and permission time never counts.`, definition.input_schema.properties.timeoutSeconds.description)
  const wire = JSON.stringify({ ...definition, eager_input_streaming: true })
  check(`samples=${enabled}: the fold 46bh wire definition with eager_input_streaming is ${bytes} bytes`, Buffer.byteLength(wire) === bytes, String(Buffer.byteLength(wire)))
}
check('the Fallback permission card prints Eval\'s description() whole (one line, so truncateToLines keeps all of it): unchanged from .36', (await EvalTool.description()) === 'Run one code cell in a retained Python or JavaScript runtime: state persists across cells, and code can call session tools, spawn crewmates, and make model completions from inside the cell.')
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
