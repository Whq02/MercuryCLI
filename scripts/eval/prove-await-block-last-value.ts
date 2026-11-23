import { check as baseCheck, cleanup, finish, loadEval, refusingBridge, setup, within } from './lib.js'

const check = (label: string, cond: boolean, detail = '', fix = ''): void => baseCheck(label, cond, cond || !fix ? detail : detail ? `${detail} — ${fix}` : fix)

const { work } = setup()
const { evalKernelManager } = await loadEval()
const { transformJsCell } = await import('../../src/tools/engines/eval-kernels/jsCellTransform.js')
const { EvalTool } = await import('../../src/tools/eval/EvalTool.js')
const run = (code: string) => within('await-block last value', 60_000, evalKernelManager.runCell({ owner: 'await-block-proof', cwd: work, input: { language: 'js', code }, abortSignal: new AbortController().signal, serveBridge: refusingBridge() }))
try {
  const measured = 'const values = await Promise.resolve([1, 2, 3]);\nconst results = [];\nfor (const value of values) { results.push({ value, match: true }); }\n({ checked: results.length, allMatch: results.every(r => r.match), results })'
  check('the leading-await and loop cell captures its final object', transformJsCell(measured).capturesResult, '', 'fix transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts so a final expression after a leading await and a loop sets capturesResult')
  const out = await run(measured)
  const mapped = EvalTool.mapToolResultToToolResultBlockParam({ ...out, language: 'js' }, 'await-block-proof')
  check('the kernel returns the measured summary, not an empty cell', out.status === 'ok' && String(mapped.content).includes('checked: 3') && String(mapped.content).includes('allMatch: true') && String(mapped.content).includes('results:'), String(mapped.content), 'the final object was lost; look at transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts and at mapToolResultToToolResultBlockParam in src/tools/eval/EvalTool.ts')
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
    check(`final value after a closed statement: ${code}`, block.content === expected && !block.is_error, String(block.content), 'the last expression after a closed statement must become the cell result; fix transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts or mapToolResultToToolResultBlockParam in src/tools/eval/EvalTool.ts')
  }
  for (const [code, inspect, expected] of [
    ['await Promise.resolve();\nconst picked = [9]\n[0]', 'picked', '9'],
    ['await Promise.resolve();\nconst called = (() => ({ count: 7 }))\n()', 'called.count', '7'],
    ["await Promise.resolve();\nconst pickedObject = { answer: 3 }\n['answer']", 'pickedObject', '3'],
  ]) {
    check(`a continued expression stays uncaptured: ${code}`, !transformJsCell(code!).capturesResult, '', 'a line starting with [ or ( continues the previous statement and must not be captured; fix transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts')
    const result = await run(code!)
    check('the continued cell executes without inventing a result', result.status === 'ok' && result.resultRepr === undefined, JSON.stringify(result.error), 'the continued cell must run unchanged and return no result; see transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts and the cell error printed here')
    const next = await run(inspect!)
    check(`continuation semantics survive: ${inspect}`, next.resultRepr === expected, String(next.resultRepr), 'the continuation must bind the indexed or called value; transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts must leave the cell source unchanged')
  }
} finally {
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('AWAIT BLOCK LAST VALUE')
