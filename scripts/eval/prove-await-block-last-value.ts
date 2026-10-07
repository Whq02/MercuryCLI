import { check, cleanup, finish, loadEval, refusingBridge, setup, within } from './lib.js'

const { work } = setup()
const { evalKernelManager } = await loadEval()
const { transformJsCell } = await import('../../src/services/eval/jsCellTransform.js')
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.js')
const run = (code: string) => within('await-block last value', 60_000, evalKernelManager.runCell({ owner: 'await-block-proof', cwd: work, input: { language: 'js', code }, abortSignal: new AbortController().signal, serveBridge: refusingBridge() }))
try {
  const measured = 'const values = await Promise.resolve([1, 2, 3]);\nconst results = [];\nfor (const value of values) { results.push({ value, match: true }); }\n({ checked: results.length, allMatch: results.every(r => r.match), results })'
  check('the leading-await and loop cell captures its final object', transformJsCell(measured).capturesResult)
  const out = await run(measured)
  const mapped = EvalTool.mapToolResultToToolResultBlockParam({ ...out, language: 'js' }, 'await-block-proof')
  check('the kernel returns the measured summary, not an empty cell', out.status === 'ok' && String(mapped.content).includes('checked: 3') && String(mapped.content).includes('allMatch: true') && String(mapped.content).includes('results:'), String(mapped.content))
  for (const [code, expected] of [
    ['await Promise.resolve();\nfor (let i = 0; i < 1; i++) {}\n[2, 4]', '⇒ [ 2, 4 ]'],
    ['await Promise.resolve();\nif (true) {}\n({ done: true })', '⇒ { done: true }'],
    ['await Promise.resolve();\ntry {} finally {}\n(await Promise.resolve(42))', '⇒ 42'],
    ['await Promise.resolve();\nfor await (const value of [1, 2]) {}\n({ count: 2 })', '⇒ { count: 2 }'],
    ['await Promise.resolve();\nfor (const x of []) {} // done\n({ done: true })', '⇒ { done: true }'],
    ['await Promise.resolve();\nconst ordinary = 3;\n({ ordinary })', '⇒ { ordinary: 3 }'],
  ]) {
    const result = await run(code!)
    const block = EvalTool.mapToolResultToToolResultBlockParam({ ...result, language: 'js' }, 'await-block-proof')
    check(`final value after a closed statement: ${code}`, block.content === expected && !block.is_error, String(block.content))
  }
  for (const [code, inspect, expected] of [
    ['await Promise.resolve();\nconst picked = [9]\n[0]', 'picked', '9'],
    ['await Promise.resolve();\nconst called = (() => ({ count: 7 }))\n()', 'called.count', '7'],
    ["await Promise.resolve();\nconst pickedObject = { answer: 3 }\n['answer']", 'pickedObject', '3'],
  ]) {
    check(`a continued expression stays uncaptured: ${code}`, !transformJsCell(code!).capturesResult)
    const result = await run(code!)
    check('the continued cell executes without inventing a result', result.status === 'ok' && result.resultRepr === undefined, JSON.stringify(result.error))
    const next = await run(inspect!)
    check(`continuation semantics survive: ${inspect}`, next.resultRepr === expected, String(next.resultRepr))
  }
} finally {
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('AWAIT BLOCK LAST VALUE')
