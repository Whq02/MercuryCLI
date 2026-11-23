#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
import { check, cleanup, finish, section, setup } from './lib.js'

const checkWithHint = (label: string, cond: boolean, detail: string | undefined, hint: string) => check(label, cond, cond ? detail : detail ? `${detail}. ${hint}` : hint)

setup()
const { EvalTool } = await import('../../src/tools/eval/EvalTool.js')
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.js')
const { evalAvailability, primeEvalAvailability, _resetInterpreterProbeCacheForTesting } = await import(
  '../../src/tools/engines/eval-kernels/interpreters.js'
)
const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.js')
await primeEvalAvailability(process.cwd())

const languagesOf = (): string[] => {
  const schema = EvalTool.inputSchema as unknown as {
    shape: { language: { options: readonly string[] } }
  }
  return [...schema.shape.language.options]
}

section('gate OFF ⇒ out of the catalogue')
process.env.MERCURY_EVAL = '0'
checkWithHint('isEnabled() false under MERCURY_EVAL=0', EvalTool.isEnabled() === false, '', 'isEnabled in src/tools/eval/EvalTool.ts must return false when evalEnabled() in src/tools/engines/eval-kernels/contracts.ts reads MERCURY_EVAL=0')
checkWithHint(
  'the catalogue assembly drops the tool',
  !getAllBaseTools().some(tool => tool.name === 'Eval'),
  '',
  'getAllBaseTools in src/tools/kit/toolList.ts must list EvalTool only when evalEnabled() is true',
)
delete process.env.MERCURY_EVAL

section('gate ON ⇒ present, and the live schema tracks the language gates')
checkWithHint('isEnabled() true with the gate on (a runnable language exists here)', EvalTool.isEnabled() === true, '', 'isEnabled in src/tools/eval/EvalTool.ts needs evalEnabled() true and one available row from evalAvailability in src/tools/engines/eval-kernels/interpreters.ts; run mercury health and read the Eval languages row')
checkWithHint('catalogue carries Eval', getAllBaseTools().some(tool => tool.name === 'Eval'), '', 'getAllBaseTools in src/tools/kit/toolList.ts must include EvalTool when evalEnabled() is true')
checkWithHint('both languages advertised on this host', languagesOf().sort().join(',') === 'js,py', languagesOf().join(','), 'the language list comes from the live schema in src/tools/eval/EvalTool.ts and the rows of evalAvailability in src/tools/engines/eval-kernels/interpreters.ts; run mercury health and read the Eval languages row to see which interpreter is missing')
process.env.MERCURY_EVAL_PY = '0'
_resetInterpreterProbeCacheForTesting()
await primeEvalAvailability(process.cwd())
const unavailableCell = { language: 'py' as const, code: '1 + 1' }
checkWithHint('an unavailable language reaches the tool refusal rather than a raw schema error', EvalTool.inputSchema.safeParse(unavailableCell).success, '', 'the language field of the schema in src/tools/eval/EvalTool.ts must keep accepting py when MERCURY_EVAL_PY=0, so call() returns the typed refusal')
{
  const { makeContext } = await import('./lib.js')
  const context = await makeContext()
  const refused = await EvalTool.call(unavailableCell, context, undefined as never, undefined as never, undefined)
  const words = JSON.stringify(EvalTool.mapToolResultToToolResultBlockParam(refused.data, 'unavailable-python'))
  checkWithHint('the unavailable Python answer carries the health reason and the available language', refused.data.status === 'error' && words.includes('MERCURY_EVAL_PY') && words.includes('js'), words, 'the refusal built by call() in src/tools/eval/EvalTool.ts must return status error and name the whyNot reason (MERCURY_EVAL_PY) and the available language js')
}
{
  const row = evalAvailability(process.cwd()).find(r => r.language === 'py')
  checkWithHint('the availability row names the gate', row?.available === false && (row?.whyNot ?? '').includes('MERCURY_EVAL_PY'), row?.whyNot, 'evalAvailability in src/tools/engines/eval-kernels/interpreters.ts must return an unavailable py row whose whyNot says MERCURY_EVAL_PY is off')
}
delete process.env.MERCURY_EVAL_PY

section('a broken interpreter pin surfaces the probe reason')
process.env.MERCURY_EVAL_PYTHON = '/nonexistent/python-for-the-prover'
_resetInterpreterProbeCacheForTesting()
await primeEvalAvailability(process.cwd())
{
  const row = evalAvailability(process.cwd()).find(r => r.language === 'py')
  checkWithHint('a dead pin falls through the ladder (py still available via python3)', row?.available === true, row?.whyNot, 'the interpreter ladder in src/tools/engines/eval-kernels/interpreters.ts must move past a failed MERCURY_EVAL_PYTHON pin to the next rung; this check also needs a python3 on PATH')
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
  checkWithHint('the first read after a reset answers at once with a probing row', Date.now() - t0 < 50 && py?.probing === true && py.available === false, JSON.stringify(py), 'evalAvailability in src/tools/engines/eval-kernels/interpreters.ts must return a probing row without waiting on the probe when the cache is empty')
  await primeEvalAvailability(process.cwd())
  checkWithHint('the settled table answers py available', evalAvailability(process.cwd()).find(r => r.language === 'py')?.available === true, '', 'after primeEvalAvailability in src/tools/engines/eval-kernels/interpreters.ts the py row must be available; this host needs a python3 on PATH')
}

section('one probe serves schema and /health (the row, run here)')
const { runtimeChecks } = await import('../../src/platform/health/sections/runtime.ts')
const evalRow = runtimeChecks().find(row => row.id === 'eval-kernels')
checkWithHint("health carries the 'eval-kernels' check", evalRow !== undefined && evalRow.label === 'Eval languages', '', 'evalKernelsCheck in src/platform/health/sections/runtime/services.ts must keep id eval-kernels and label Eval languages, and runtimeChecks must include it')
const evalSays = await evalRow?.run()
const settled = evalAvailability(process.cwd())
checkWithHint('the health check reads the SAME availability probe (the settled table)', settled.length > 0 && settled.every(row => evalSays?.evidence.includes(row.available ? `${row.language} ${row.version ?? 'ok'} @ ${row.interpreterPath ?? '?'}` : `${row.language} UNAVAILABLE (${row.whyNot ?? 'unknown'})`) === true), evalSays?.evidence, 'the evidence of evalKernelsCheck in src/platform/health/sections/runtime/services.ts must list every row of evalAvailability in the same wording')

section('registry + census rows')
const flagNames = new Set((FLAG_REGISTRY as ReadonlyArray<{ env: string }>).map(row => row.env))
for (const flag of ['MERCURY_EVAL', 'MERCURY_EVAL_PY', 'MERCURY_EVAL_JS', 'MERCURY_EVAL_PYTHON']) {
  checkWithHint(`flag registry row ${flag}`, flagNames.has(flag), '', 'add a row for this flag to the eval group of FLAG_REGISTRY')
}
const { toolCensus } = await import('../builtin-tools/census-gen.ts')
checkWithHint('census carries Eval', toolCensus().anchor.rows.some(row => row.name === 'Eval'), '', 'buildToolCensus in src/permissions/capability-census/census.ts must produce a row named Eval; the tool must be in the catalogue when the census is built')

cleanup()
finish('EVAL-CATALOGUE')
