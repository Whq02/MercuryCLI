import { check, cleanup, finish, setup } from './lib.js'
import { CODE_TOOL_KEYS } from '../identity/forbidden-code-tool.js'

setup()
const { EvalTool } = await import('../../src/tools/eval/EvalTool.js')
const { primeEvalAvailability } = await import('../../src/tools/engines/eval-kernels/interpreters.js')
const { formatZodValidationError, parameterStandIn } = await import('../../src/tools/kit/toolErrors.js')
await primeEvalAvailability(process.cwd())
const [batch, budget, language] = CODE_TOOL_KEYS
const error = (input: unknown): string => {
  const parsed = EvalTool.inputSchema.safeParse(input)
  return parsed.success ? '' : formatZodValidationError('Eval', parsed.error)
}
for (const [key, value] of [[batch, [{ language: 'js', code: '1' }]], [budget, 5000]] as const) {
  const actual = error({ language: 'js', code: '1', [key]: value })
  const generic = error({ language: 'js', code: '1', unknownField: value })
  const genericOk = parameterStandIn('Eval', key) === undefined && actual.replaceAll(key, 'unknownField') === generic && actual.includes('was not expected')
  check('unsupported fields use generic validation, without a stand-in', genericOk, genericOk ? actual : `${actual} — a retired Eval key must read like any unknown field: remove its stand-in from parameterStandIn in src/tools/kit/toolErrors.ts, and check the Eval input schema in src/tools/eval/EvalTool.ts does not name it`)
}
const missing = error({ [batch]: [] })
const missingOk = missing.includes('`language`') && missing.includes('"py", "js"') && missing.includes('`code` is missing')
check('a batch input is not a cell and still needs both required fields', missingOk, missingOk ? missing : `${missing} — the Eval input schema in src/tools/eval/EvalTool.ts must keep language and code required, and formatZodValidationError in src/tools/kit/toolErrors.ts must name both`)
const enumOk = error({ language, code: '1' }) === error({ language: 'nonsense', code: '1' })
check('unsupported language uses the generic enum refusal', enumOk, enumOk ? '' : 'a retired language value must get the same refusal as any other unsupported one: remove any special case for it in the language field of the Eval input schema in src/tools/eval/EvalTool.ts')
const validCell = { language: 'js', code: '1', title: 'one', timeoutSeconds: 0, reset: false }
const cellOk = EvalTool.inputSchema.safeParse(validCell).success
check('the five-field cell remains valid', cellOk, cellOk ? '' : 'the Eval input schema in src/tools/eval/EvalTool.ts must accept language, code, title, timeoutSeconds and reset')
cleanup()
finish('EVAL GENERIC INPUT VALIDATION')
