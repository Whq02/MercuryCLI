import { mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { deepStrictEqual } from 'node:assert'
import { check as baseCheck, cleanup, finish, setup } from './lib.js'
import { CODE_TOOL_SPELLINGS } from '../identity/forbidden-code-tool.js'

const check = (label: string, cond: boolean, detail = '', hint = ''): void =>
  baseCheck(label, cond, cond || !hint ? detail : detail ? `${detail} — ${hint}` : hint)

setup()
const original = await import('../../src/tools/engines/eval-kernels/interpreters.js')
const availability = [
  { language: 'py', available: true, version: 'Python 3.13.13', interpreterPath: 'python3' },
  { language: 'js', available: true, version: 'v24.20.0', interpreterPath: 'node' },
]
mock.module('../../src/tools/engines/eval-kernels/interpreters.js', () => ({ ...original, evalAvailability: () => availability, primeEvalAvailability: async () => availability }))
const contracts = await import('../../src/tools/engines/eval-kernels/contracts.js')
const { EvalTool } = await import('../../src/tools/eval/EvalTool.js')
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.js')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.js')
const { toolToAPISchema } = await import('../../src/engine/messages/apiSystemAndToolSchema.js')
const { clearToolSchemaCache } = await import('../../src/models/roads/toolSchemaCache.js')
const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.js')
const expected = {
  type: 'object', properties: {
    language: { type: 'string', enum: ['py', 'js'], description: 'The retained runtime this cell runs in.' },
    code: { type: 'string', minLength: 1, description: 'The cell source.' },
    title: { description: 'Short human title for the cell card.', type: 'string' },
    timeoutSeconds: { description: 'Runtime budget in seconds: default 30, at most 600; 0 disables; time inside tool calls and permission waits never counts.', type: 'integer', minimum: 0, maximum: 9007199254740991 },
    reset: { description: "Recreate this language's kernel first (the other language keeps its state).", type: 'boolean' },
  }, required: ['language', 'code'], additionalProperties: false,
}
const options = { tools: [EvalTool, { name: 'Inspect' }] as never, agents: [], getToolPermissionContext: async () => getEmptyToolPermissionContext() }
for (const [enabled, hash, manualBytes, bytes] of [
  ['1', '87372947bdccf36adc9a64083524280e7e18431e03073bf862c98049a7675d52', 6503, 1421],
  ['0', '2589897829f454e597585b3804ec74be7e6ae33a97b1a191b310d8916778bd7f', 4469, 1217],
] as const) {
  process.env.MERCURY_SAMPLES = enabled
  clearToolSchemaCache()
  const manual = await EvalTool.prompt(options)
  const definition = await toolToAPISchema(EvalTool, options) as any
  check(`samples=${enabled}: the complete manual matches the 1.0.5 text (the steering sentences gone, the helper reference whole; ${manualBytes} bytes)`, createHash('sha256').update(manual).digest('hex') === hash && Buffer.byteLength(manual) === manualBytes, `${Buffer.byteLength(manual)} bytes: ${manual}`, 'the manual comes from buildEvalPrompt in src/tools/eval/prompt.ts; change it there, or update the recorded hash and byte count in this proof if the new manual text is intended')
  check(`samples=${enabled}: the wire carries the Eval wire contract rendered from that manual (fold 46bh), the manual arriving on discovery or first use`, typeof EvalTool.wireDescription === 'function' && definition.description === EvalTool.wireDescription(manual) && definition.description.includes('their signatures arrive on first use') && !definition.description.includes('Bash/Read/Edit') && !definition.description.includes('never retry'), definition.description, 'the wire description comes from wireDescription in src/tools/eval/EvalTool.ts; it must equal EvalTool.wireDescription(manual) and keep the first-use sentence')
  let same = true
  try { deepStrictEqual(definition.input_schema, expected) } catch { same = false }
  check('five-field wire schema matches exactly', same, JSON.stringify(definition.input_schema), 'the input schema of EvalTool in src/tools/eval/EvalTool.ts must expose exactly language, code, title, timeoutSeconds and reset with the descriptions in this proof')
  check(`samples=${enabled}: the timeoutSeconds field names the runtime constants (default ${contracts.EVAL_DEFAULT_TIMEOUT_SECONDS}, at most ${contracts.EVAL_MAX_TIMEOUT_SECONDS}) from contracts.ts`, definition.input_schema.properties.timeoutSeconds.description === `Runtime budget in seconds: default ${contracts.EVAL_DEFAULT_TIMEOUT_SECONDS}, at most ${contracts.EVAL_MAX_TIMEOUT_SECONDS}; 0 disables; time inside tool calls and permission waits never counts.`, definition.input_schema.properties.timeoutSeconds.description, 'the timeoutSeconds description in src/tools/eval/EvalTool.ts must be built from EVAL_DEFAULT_TIMEOUT_SECONDS and EVAL_MAX_TIMEOUT_SECONDS in src/tools/engines/eval-kernels/contracts.ts')
  const wire = JSON.stringify({ ...definition, eager_input_streaming: true })
  check(`samples=${enabled}: the fold 46bh wire definition with eager_input_streaming is ${bytes} bytes`, Buffer.byteLength(wire) === bytes, String(Buffer.byteLength(wire)), 'the serialized wire definition of EvalTool (src/tools/eval/EvalTool.ts schema and wireDescription) changed size; restore it, or update the recorded byte count in this proof if the change is intended')
}
check('the Fallback permission card prints Eval\'s description() whole (one line, so truncateToLines keeps all of it): unchanged from .36', (await EvalTool.description()) === 'Run one code cell in a retained Python or JavaScript runtime: state persists across cells, and code can call session tools, spawn crewmates, and make model completions from inside the cell.', '', 'EVAL_DESCRIPTION in src/tools/eval/prompt.ts must read exactly as the text in this proof')
const noInspect = await EvalTool.prompt({ ...options, tools: [EvalTool] })
check('Inspect is named only when available in the session pool', !noInspect.includes('tool.Inspect({ref})'), '', 'buildEvalPrompt in src/tools/eval/prompt.ts must name Inspect only when Inspect is in the tools it is given')
check('the tool remains loaded in full', EvalTool.shouldDefer !== true, '', 'remove shouldDefer: true from EvalTool in src/tools/eval/EvalTool.ts')
if (!process.argv.includes('--contract-only')) {
  const names = getAllBaseTools().map(tool => tool.name)
  check('the catalogue has only the retained code tool', names.includes('Eval') && !names.includes(CODE_TOOL_SPELLINGS[0]), '', 'getAllBaseTools in src/tools/kit/toolList.ts must list Eval and no retired code tool name')
  check('the retired runtime gate no longer exists', !FLAG_REGISTRY.some(flag => flag.env === CODE_TOOL_SPELLINGS[1]), '', 'remove the retired runtime gate entry from FLAG_REGISTRY')
}
cleanup()
finish('EVAL SINGLE RUNTIME CATALOGUE')
