import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check as baseCheck, cleanup, finish, loadEval, refusingBridge, setup, within } from './lib.js'

const check = (label: string, cond: boolean, detail = '', fix = ''): void => baseCheck(label, cond, cond || !fix ? detail : detail ? `${detail} — ${fix}` : fix)

const { work } = setup()
const { evalKernelManager } = await loadEval()
const { transformJsCell } = await import('../../src/tools/engines/eval-kernels/jsCellTransform.js')
const { EvalTool } = await import('../../src/tools/eval/EvalTool.js')
const run = (code: string) => within('last-value cell', 60_000, evalKernelManager.runCell({ owner: 'last-value-proof', cwd: work, input: { language: 'js', code }, abortSignal: new AbortController().signal, serveBridge: refusingBridge() }))
try {
  for (const [code, expected] of [
    ['const kind = "string";\n({ ok: true, kind, length: 3 });', "⇒ { ok: true, kind: 'string', length: 3 }"],
    ['[1, 2].map(x => x * 2)', '⇒ [ 2, 4 ]'],
    ['({ a: 1 });', '⇒ { a: 1 }'],
    ['// a single statement\n({ a: 1 });', '⇒ { a: 1 }'],
    ['const v = 2; // separate statement\n({ v });', '⇒ { v: 2 }'],
    ['const v = 3;\n// interstitial trivia\n[v];', '⇒ [ 3 ]'],
    ['({ a: 1 }) // trailing explanation', '⇒ { a: 1 }'],
    ['[1, 2] // trailing explanation', '⇒ [ 1, 2 ]'],
    ['const before = 1;\n[before, 2]', '⇒ [ 1, 2 ]'],
    ['(await Promise.resolve({version: 1})).version', '⇒ 1'],
    ['await Promise.resolve(4)', '⇒ 4'],
  ]) {
    const out = await run(code!)
    const mapped = EvalTool.mapToolResultToToolResultBlockParam({ ...out, language: 'js' }, 'last-value-proof')
    check(`final expression: ${code}`, mapped.content === expected && !mapped.is_error, String(mapped.content), 'the last expression of the cell must become the result; fix transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts or mapToolResultToToolResultBlockParam in src/tools/eval/EvalTool.ts')
  }
  const empty = await run('undefined')
  const mappedEmpty = EvalTool.mapToolResultToToolResultBlockParam({ ...empty, language: 'js' }, 'empty-cell-proof')
  check('undefined plainly reports no output', mappedEmpty.content === '(the cell produced no output)' && !mappedEmpty.is_error, String(mappedEmpty.content), 'an undefined result must print the no-output line; see mapToolResultToToolResultBlockParam in src/tools/eval/EvalTool.ts')
  const continuation = 'const a = [1]\n[0]'
  check('an array continuation without a semicolon is not captured', !transformJsCell(continuation).capturesResult, '', 'a line starting with [ continues the previous statement and must not be captured; fix transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts')
  const continued = await run(continuation)
  check('an array continuation still executes unchanged', continued.status === 'ok' && continued.resultRepr === undefined, JSON.stringify(continued.error), 'the continued cell must run as written with no result; see transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts')
  const next = await run('a')
  check('the original continuation still binds the selected value', next.resultRepr === '1', '', 'the continuation must bind a to the indexed value; transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts must not rewrite it')
  const callContinuation = 'const f = x => x\n(3)'
  check('a call continuation is not captured as a new statement', !transformJsCell(callContinuation).capturesResult, '', 'a line starting with ( continues the previous statement and must not be captured; fix transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts')
  const measuredShape = 'const r = await tool.attempt.Glob({ pattern: "**/package.json", path: "/fixture" });\nglobResult = r;\nconst v = r.ok ? r.value : r.error;\nconst kind = typeof v;\nconst preview = kind === "string" ? v.slice(0, 600) : JSON.stringify(v, null, 1).slice(0, 600);\n({ ok: r.ok, kind, isArray: Array.isArray(v), length: kind === "string" ? v.length : (Array.isArray(v) ? v.length : Object.keys(v ?? {})), preview });'
  check('the measured lost-object cell captures its final value', transformJsCell(measuredShape).capturesResult, '', 'fix transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts so the final parenthesised object after several declarations is captured')

  writeFileSync(join(work, 'eval-shape-module.mjs'), 'export const answer = 42\n')
  const dynamic = await run("const shapeModule = await import('./eval-shape-module.mjs')\nshapeModule.answer")
  check('a dynamic import() of a relative module resolves against the cell cwd and its binding persists', dynamic.status === 'ok' && dynamic.resultRepr === '42', JSON.stringify(dynamic.error ?? dynamic.resultRepr), 'a cell with await import() must resolve against the cell cwd and persist its binding; see the cell runner in src/tools/engines/eval-kernels/jsRunnerSource.ts and transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts')
  const dynamicNext = await run('shapeModule.answer + 1')
  check('…and the next cell still reads it', dynamicNext.resultRepr === '43', JSON.stringify(dynamicNext.error ?? dynamicNext.resultRepr), 'the binding of the previous cell was not persisted; see persistedNames in transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts')
  const defaults = await run("const shapeRaw = '{\"a\":1}'\nconst { shapeKey: shapeA = 10, shapeB = JSON.parse(shapeRaw).a + 1 } = { shapeKey: undefined }\nshapeA + shapeB")
  check('a destructuring declaration with default values runs and captures its value', defaults.status === 'ok' && defaults.resultRepr === '12', JSON.stringify(defaults.error ?? defaults.resultRepr), 'a destructuring declaration with defaults must run and be captured; fix transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts')
  const defaultsNext = await run('JSON.stringify([shapeA, shapeB, typeof JSON === "object", "parse" in globalThis, Object.hasOwn(globalThis, "shapeKey")])')
  check('…the bound names persist and neither the pattern key nor anything from the default expressions was exported', defaultsNext.resultRepr === "'[10,2,true,false,false]'", JSON.stringify(defaultsNext.error ?? defaultsNext.resultRepr), 'only the bound names of a destructuring declaration may persist, not its keys or default expressions; fix the persisted-name collection in src/tools/engines/eval-kernels/jsCellTransform.ts')
  const nested = await run("try { var shapeParsed = JSON.parse('{\"x\":5}') } catch {}\nif (shapeParsed) { var shapeInIf = 7 }\nshapeParsed.x + shapeInIf")
  check('var declared inside try and if blocks runs and captures its value', nested.status === 'ok' && nested.resultRepr === '12', JSON.stringify(nested.error ?? nested.resultRepr), 'var declared inside try and if blocks must run and be captured; fix transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts')
  const nestedNext = await run('JSON.stringify([shapeParsed, shapeInIf])')
  check('…and both block-nested vars persist to the next cell', nestedNext.resultRepr === "'[{\"x\":5},7]'", JSON.stringify(nestedNext.error ?? nestedNext.resultRepr), 'block-nested var names must persist across cells; fix the persisted-name collection in src/tools/engines/eval-kernels/jsCellTransform.ts')
  const returned = await run('const shapeN = 41\nreturn shapeN + 1')
  check('a top-level return hands its value back as the cell result', returned.status === 'ok' && returned.resultRepr === '42', JSON.stringify(returned.error ?? returned.resultRepr), 'a top-level return must become the cell result; see the cell runner in src/tools/engines/eval-kernels/jsRunnerSource.ts and transformJsCell in src/tools/engines/eval-kernels/jsCellTransform.ts')
  const returnedNext = await run('shapeN')
  check('…and the declaration before the return still persisted', returnedNext.resultRepr === '41', JSON.stringify(returnedNext.error ?? returnedNext.resultRepr), 'declarations before a top-level return must still persist; fix the persisted-name collection in src/tools/engines/eval-kernels/jsCellTransform.ts')
  const returnedNothing = await run('const shapeSilent = 1\nreturn')
  check('a bare return yields no result frame', returnedNothing.status === 'ok' && returnedNothing.resultRepr === undefined, JSON.stringify(returnedNothing), 'a bare return must produce no result frame; see the cell runner in src/tools/engines/eval-kernels/jsRunnerSource.ts')
} finally {
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('EVAL JS LAST VALUE')
