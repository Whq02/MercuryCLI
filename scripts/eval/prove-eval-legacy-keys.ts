import { check, cleanup, finish, setup } from './lib.js'
import { CODE_TOOL_KEYS } from '../identity/forbidden-code-tool.js'

setup()
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.js')
const { primeEvalAvailability } = await import('../../src/services/eval/interpreters.js')
const { formatZodValidationError, parameterStandIn } = await import('../../src/utils/toolErrors.js')
await primeEvalAvailability(process.cwd())
const [batch, budget, language] = CODE_TOOL_KEYS
const error = (input: unknown): string => {
  const parsed = EvalTool.inputSchema.safeParse(input)
  return parsed.success ? '' : formatZodValidationError('Eval', parsed.error)
}
for (const [key, value] of [[batch, [{ language: 'js', code: '1' }]], [budget, 5000]] as const) {
  const actual = error({ language: 'js', code: '1', [key]: value })
  const generic = error({ language: 'js', code: '1', unknownField: value })
  check('unsupported fields use generic validation, without a stand-in', parameterStandIn('Eval', key) === undefined && actual.replaceAll(key, 'unknownField') === generic && actual.includes('was not expected'), actual)
}
const missing = error({ [batch]: [] })
check('a batch input is not a cell and still needs both required fields', missing.includes('`language`') && missing.includes('"py", "js"') && missing.includes('`code` is missing'), missing)
check('unsupported language uses the generic enum refusal', error({ language, code: '1' }) === error({ language: 'nonsense', code: '1' }))
const validCell = { language: 'js', code: '1', title: 'one', timeoutSeconds: 0, reset: false }
check('the five-field cell remains valid', EvalTool.inputSchema.safeParse(validCell).success)
cleanup()
finish('EVAL GENERIC INPUT VALIDATION')
