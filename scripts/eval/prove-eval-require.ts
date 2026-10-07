import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, cleanup, finish, loadEval, refusingBridge, setup, within } from './lib.js'

const { work } = setup()
const { evalKernelManager } = await loadEval()
const { JS_KERNEL_MODULE_WORDS } = await import('../../src/services/eval/jsKernelWords.js')
const run = (code: string) => within('require cell', 60_000, evalKernelManager.runCell({ owner: 'require-proof', cwd: work, input: { language: 'js', code }, abortSignal: new AbortController().signal, serveBridge: refusingBridge() }))
try {
  const builtin = await run("const path = require('node:path'); path.join('a', 'b')")
  check('require resolves node builtins', builtin.status === 'ok' && builtin.resultRepr === JSON.stringify(join('a', 'b')).replace(/^"|"$/g, "'"), JSON.stringify(builtin))
  writeFileSync(join(work, 'm.cjs'), 'module.exports = 1')
  const one = await run("require('./m.cjs')")
  writeFileSync(join(work, 'm.cjs'), 'module.exports = 2')
  const two = await run("require('./m.cjs')")
  check('changed local modules are re-read on the next cell', one.resultRepr === '1' && two.resultRepr === '2', `${one.resultRepr} -> ${two.resultRepr}`)
  mkdirSync(join(work, 'node_modules', 'cell-package'), { recursive: true })
  writeFileSync(join(work, 'node_modules', 'cell-package', 'index.js'), 'module.exports = { n: 1 }')
  const packageOne = await run("const pkg = require('cell-package'); pkg.n")
  writeFileSync(join(work, 'node_modules', 'cell-package', 'index.js'), 'module.exports = { n: 2 }')
  const packageTwo = await run("require('cell-package') === pkg")
  check('node_modules entries retain their identity', packageOne.resultRepr === '1' && packageTwo.resultRepr === 'true')
  const module = await run('module.exports')
  check('module is still absent with the accurate environment note', module.status === 'error' && module.error?.value === 'module is not defined' && module.annotations.includes(JS_KERNEL_MODULE_WORDS) && JS_KERNEL_MODULE_WORDS.includes('`require()` resolves from the working directory'))
  const imported = await run("import { basename } from 'node:path'; basename('/a/b')")
  check('static imports remain available beside require', imported.status === 'ok' && imported.resultRepr === "'b'", JSON.stringify(imported))
} finally {
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('EVAL REQUIRE')
