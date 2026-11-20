#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { check, cleanup, finish, section, setup } from './lib.js'

setup()
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.js')
const { getAllBaseTools } = await import('../../src/tools.js')
const { evalAvailability, primeEvalAvailability, _resetInterpreterProbeCacheForTesting } = await import(
  '../../src/services/eval/interpreters.js'
)
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.js')
await primeEvalAvailability(process.cwd())

const languagesOf = (): string[] => {
  const schema = EvalTool.inputSchema as unknown as {
    shape: { language: { options: readonly string[] } }
  }
  return [...schema.shape.language.options]
}

section('gate OFF ⇒ out of the catalogue')
process.env.MERCURY_EVAL = '0'
check('isEnabled() false under MERCURY_EVAL=0', EvalTool.isEnabled() === false)
check(
  'the catalogue assembly drops the tool',
  !getAllBaseTools().some(tool => tool.name === 'Eval'),
)
delete process.env.MERCURY_EVAL

section('gate ON ⇒ present, and the live schema tracks the language gates')
check('isEnabled() true with the gate on (a runnable language exists here)', EvalTool.isEnabled() === true)
check('catalogue carries Eval', getAllBaseTools().some(tool => tool.name === 'Eval'))
check('both languages advertised on this host', languagesOf().sort().join(',') === 'js,py', languagesOf().join(','))
process.env.MERCURY_EVAL_PY = '0'
_resetInterpreterProbeCacheForTesting()
await primeEvalAvailability(process.cwd())
const unavailableCell = { language: 'py' as const, code: '1 + 1' }
check('an unavailable language reaches the tool refusal rather than a raw schema error', EvalTool.inputSchema.safeParse(unavailableCell).success)
{
  const { makeContext } = await import('./lib.js')
  const context = await makeContext()
  const refused = await EvalTool.call(unavailableCell, context, undefined as never, undefined as never, undefined)
  const words = JSON.stringify(EvalTool.mapToolResultToToolResultBlockParam(refused.data, 'unavailable-python'))
  check('the unavailable Python answer carries the health reason and the available language', refused.data.status === 'error' && words.includes('MERCURY_EVAL_PY') && words.includes('js'), words)
}
{
  const row = evalAvailability(process.cwd()).find(r => r.language === 'py')
  check('the availability row names the gate', row?.available === false && (row?.whyNot ?? '').includes('MERCURY_EVAL_PY'), row?.whyNot)
}
delete process.env.MERCURY_EVAL_PY

section('a broken interpreter pin surfaces the probe reason')
process.env.MERCURY_EVAL_PYTHON = '/nonexistent/python-for-the-prover'
_resetInterpreterProbeCacheForTesting()
await primeEvalAvailability(process.cwd())
{
  const row = evalAvailability(process.cwd()).find(r => r.language === 'py')
  check('a dead pin falls through the ladder (py still available via python3)', row?.available === true, row?.whyNot)
}
delete process.env.MERCURY_EVAL_PYTHON
_resetInterpreterProbeCacheForTesting()
await primeEvalAvailability(process.cwd())

section('the schema getter and the enabled predicate never block on a probe')
_resetInterpreterProbeCacheForTesting()
{
  const t0 = Date.now()
  const rows = evalAvailability(process.cwd())
  const py = rows.find(r => r.language === 'py')
  check('the first read after a reset answers at once with a probing row', Date.now() - t0 < 50 && py?.probing === true && py.available === false, JSON.stringify(py))
  await primeEvalAvailability(process.cwd())
  check('the settled table answers py available', evalAvailability(process.cwd()).find(r => r.language === 'py')?.available === true)
}

section('one probe serves schema and /health (the row, run here)')
const { runtimeChecks } = await import('../../src/services/health/sections/runtime.ts')
const evalRow = runtimeChecks().find(row => row.id === 'eval-kernels')
check("health carries the 'eval-kernels' check", evalRow !== undefined && evalRow.label === 'Eval languages')
const evalSays = await evalRow?.run()
const settled = evalAvailability(process.cwd())
check('the health check reads the SAME availability probe (the settled table)', settled.length > 0 && settled.every(row => evalSays?.evidence.includes(row.available ? `${row.language} ${row.version ?? 'ok'} @ ${row.interpreterPath ?? '?'}` : `${row.language} UNAVAILABLE (${row.whyNot ?? 'unknown'})`) === true), evalSays?.evidence)

section('registry + census rows')
const flagNames = new Set((FLAG_REGISTRY as ReadonlyArray<{ env: string }>).map(row => row.env))
for (const flag of ['MERCURY_EVAL', 'MERCURY_EVAL_PY', 'MERCURY_EVAL_JS', 'MERCURY_EVAL_PYTHON']) {
  check(`flag registry row ${flag}`, flagNames.has(flag))
}
const { toolCensus } = await import('../builtin-tools/census-gen.ts')
check('census carries Eval', toolCensus().anchor.rows.some(row => row.name === 'Eval'))

cleanup()
finish('EVAL-CATALOGUE')
