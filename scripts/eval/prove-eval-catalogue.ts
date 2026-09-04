#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, cleanup, finish, section, setup } from './lib.js'

setup()
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.js')
const { getAllBaseTools } = await import('../../src/tools.js')
const { evalAvailability, primeEvalAvailability, _resetInterpreterProbeCacheForTesting } = await import(
  '../../src/services/eval/interpreters.js'
)
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.js')
await primeEvalAvailability(process.cwd())

const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', ...p), 'utf-8')

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
check('MERCURY_EVAL_PY=0 ⇒ py leaves the LIVE schema', languagesOf().join(',') === 'js', languagesOf().join(','))
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
  check('the probe owner has no synchronous spawn', !/spawnSync|execFileSync|execSync/.test(src('src', 'services', 'eval', 'interpreters.ts')))
  await primeEvalAvailability(process.cwd())
  check('the settled table answers py available', evalAvailability(process.cwd()).find(r => r.language === 'py')?.available === true)
}

section('one probe serves schema, /health and doctor (source pins)')
const health = src('src', 'utils', 'healthReport.ts')
check("health carries the 'eval-kernels' check", health.includes("id: 'eval-kernels'"))
check('the health check reads the SAME availability probe (the settled table)', /eval-kernels'[\s\S]{0,900}primeEvalAvailability/.test(health))
check("doctor is health's alias (one row serves both)", /command\('health'\)\.alias\('doctor'\)/.test(src('src', 'main.tsx')))

section('registry + census rows')
const flagNames = new Set((FLAG_REGISTRY as ReadonlyArray<{ env: string }>).map(row => row.env))
for (const flag of ['MERCURY_EVAL', 'MERCURY_EVAL_PY', 'MERCURY_EVAL_JS', 'MERCURY_EVAL_PYTHON']) {
  check(`flag registry row ${flag}`, flagNames.has(flag))
}
check('capability declaration exists', src('src', 'utils', 'capability', 'declarations.ts').includes('  Eval: {'))
check('census fixture carries Eval', src('scripts', 'builtin-tools', 'fixtures', 'tool-census.json').includes('"Eval"'))

cleanup()
finish('EVAL-CATALOGUE')
