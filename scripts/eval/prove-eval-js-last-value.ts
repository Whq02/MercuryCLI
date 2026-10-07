import { check, cleanup, finish, loadEval, refusingBridge, setup, within } from './lib.js'

const { work } = setup()
const { evalKernelManager } = await loadEval()
const { transformJsCell } = await import('../../src/services/eval/jsCellTransform.js')
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.js')
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
    check(`final expression: ${code}`, mapped.content === expected && !mapped.is_error, String(mapped.content))
  }
  const continuation = 'const a = [1]\n[0]'
  check('an array continuation without a semicolon is not captured', !transformJsCell(continuation).capturesResult)
  const continued = await run(continuation)
  check('an array continuation still executes unchanged', continued.status === 'ok' && continued.resultRepr === undefined, JSON.stringify(continued.error))
  const next = await run('a')
  check('the original continuation still binds the selected value', next.resultRepr === '1')
  const callContinuation = 'const f = x => x\n(3)'
  check('a call continuation is not captured as a new statement', !transformJsCell(callContinuation).capturesResult)
  const measuredShape = 'const r = await tool.attempt.Glob({ pattern: "**/package.json", path: "/fixture" });\nglobResult = r;\nconst v = r.ok ? r.value : r.error;\nconst kind = typeof v;\nconst preview = kind === "string" ? v.slice(0, 600) : JSON.stringify(v, null, 1).slice(0, 600);\n({ ok: r.ok, kind, isArray: Array.isArray(v), length: kind === "string" ? v.length : (Array.isArray(v) ? v.length : Object.keys(v ?? {})), preview });'
  check('the measured lost-object cell captures its final value', transformJsCell(measuredShape).capturesResult)
} finally {
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('EVAL JS LAST VALUE')
