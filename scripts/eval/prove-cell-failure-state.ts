#!/usr/bin/env bun
import { check, cleanup, finish, loadEval, section, setup, within } from './lib.js'

const { work } = setup()
const { evalKernelManager } = await loadEval()
const { transformJsCell } = await import('../../src/services/eval/jsCellTransform.ts')
const { nestedCallsLine, stateAfterFailure } = await import('../../src/services/eval/kernelManager.ts')

const bridge: import('../../src/services/eval/kernelManager.js').BridgeServer = async frame => {
  if (frame.kind !== 'tool') return { ok: false, error: 'no such bridge kind in this prover' }
  const name = (frame.payload as { name?: string }).name ?? ''
  if (name === 'Refused') return { ok: false, error: 'the bridge refused this call' }
  return { ok: true, value: `${name}-answer` }
}
const run = (owner: string, language: 'py' | 'js', code: string) =>
  within(
    `${language} cell`,
    60_000,
    evalKernelManager.runCell({ owner, cwd: work, input: { language, code }, abortSignal: new AbortController().signal, serveBridge: bridge }),
  )
const AsyncFunction = (async () => {}).constructor as new (code: string) => () => Promise<unknown>

try {
  section('§T the transform commits bindings as they land')
  const t1 = transformJsCell('let n = 1\nif (n > 0)\n  n = 5\nelse\n  n = 6\nn = n + 1\nn')
  check('T1 no tail stands between a brace-less if body and its else', !/n = 5\s*\n\s*;\(\(\) =>/.test(t1.code) && !/else\s*\n\s*;\(\(\) =>/.test(t1.code), t1.code)
  const t2 = transformJsCell('const y = [1, 2, 3]\n  .map(v => v * 2)\n  .filter(v => v > 2)\nconst z = 1\n')
  check('T2 a leading-dot chain is never split by a tail', /\.filter\(v => v > 2\)\s*\n\s*;\(\(\) =>/.test(t2.code) && !/\[1, 2, 3\]\s*\n\s*;/.test(t2.code), t2.code)
  const t3 = transformJsCell('var root, hb, logs\nroot = 1\nthrow new Error("boom")\nlogs = 2\n')
  check('T3 a declaration commits before the throw', t3.code.includes('globalThis.root = root') && t3.code.includes('throw new Error') && t3.code.indexOf('globalThis.root = root') < t3.code.indexOf('throw new Error'))
  for (const src of ['let n = 1\nif (n > 0)\n  n = 5\nelse\n  n = 6\nn = n + 1\nn', 'let k = 1\nfor (const a of [1, 2])\n  k += a\nk', 'const t = {\n  a: 1,\n}\nt.a', 'const y = [1, 2, 3]\n  .map(v => v * 2)\n  .filter(v => v > 2)\ny']) {
    let ok = true
    try {
      await new AsyncFunction(transformJsCell(src).code).call(globalThis)
    } catch {
      ok = false
    }
    check(`T4 the transformed cell still runs: ${src.split('\n')[0]}`, ok)
  }
  const g = globalThis as Record<string, unknown>
  check('T5 …with the expected values', g.n === 6 && g.k === 4 && JSON.stringify(g.y) === '[4,6]')
  for (const n of ['n', 'k', 't', 'y']) delete g[n]

  section('§S a failed cell names what survived')
  const s1 = await run('owner-S', 'js', 'var root, hb, logs\nroot = 1\nconst made = 2\nthrow new Error("boom")\nconst never = 3\n')
  check('S1 the JS cell failed', s1.status === 'error' && s1.error?.value === 'boom', JSON.stringify(s1.error))
  const survivedNote = s1.annotations.find(a => a.startsWith('bindings that survived'))
  check('S2 the result names the survivors', survivedNote !== undefined && survivedNote.includes('root') && survivedNote.includes('made') && survivedNote.includes('logs'), JSON.stringify(s1.annotations))
  check('S3 …and the name declared after the throw as never bound', survivedNote !== undefined && /never bound.*never/.test(survivedNote), survivedNote ?? '')
  const s2 = await run('owner-S', 'js', 'JSON.stringify([root, made, typeof logs, typeof never])')
  check('S4 the next cell reads the survivors', s2.status === 'ok' && s2.resultRepr === "'[1,2,\"undefined\",\"undefined\"]'", s2.resultRepr ?? JSON.stringify(s2.error))
  const p1 = await run('owner-S', 'py', 'kept = 1\nalso = [1, 2]\nraise ValueError("boom")\nlost = 3\n')
  check('P1 the Python cell failed', p1.status === 'error' && p1.error?.name === 'ValueError', JSON.stringify(p1.error))
  const pyNote = p1.annotations.find(a => a.startsWith('bindings this failed cell made'))
  check('P2 the result names the bindings made before the error', pyNote !== undefined && pyNote.includes('also') && pyNote.includes('kept') && !pyNote.includes('lost'), JSON.stringify(p1.annotations))
  const p2 = await run('owner-S', 'py', 'kept + len(also)')
  check('P3 the next Python cell reads them', p2.status === 'ok' && p2.resultRepr === '3', p2.resultRepr ?? JSON.stringify(p2.error))
  check('P4 the pure composer: no survived field ⇒ no note', stateAfterFailure('js', ['a'], undefined).length === 0)
  check('P5 the pure composer: nothing survived says so', stateAfterFailure('js', ['a'], { survived: [] })[0] === 'no top-level binding of this cell survived; never bound (declared after the throw or uninitialised): a')

  section('§N the nested-call ledger')
  const n1 = await run('owner-N', 'js', 'const a = await tool.Read({ file_path: "/x" })\nconst b = await tool.Refused({})\nconst c = await tool.Grep({ pattern: "x" })\n')
  check('N1 the cell fails at the refused call', n1.status === 'error' && (n1.error?.value ?? '').includes('the bridge refused this call'), JSON.stringify(n1.error))
  const ledger = n1.annotations.find(a => a.startsWith('nested calls'))
  check('N2 the ledger lists every call in order with its outcome', ledger === 'nested calls (2, 1 failed): 1 Read ok · 2 Refused failed (the bridge refused this call)', ledger ?? JSON.stringify(n1.annotations))
  check('N3 the survivors note says a landed and b did not', (n1.annotations.find(x => x.startsWith('bindings that survived')) ?? '').includes('a') && /never bound.*b/.test(n1.annotations.find(x => x.startsWith('bindings that survived')) ?? ''), JSON.stringify(n1.annotations))
  const n2 = await run('owner-N', 'js', 'const d = await tool.Read({ file_path: "/y" })\nd')
  check('N4 a clean cell with clean calls carries no ledger line', n2.status === 'ok' && !n2.annotations.some(a => a.startsWith('nested calls')), JSON.stringify(n2.annotations))
  check('N5 the pure line is bounded', (nestedCallsLine(Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, name: 'T', ok: true }))) ?? '').endsWith('· +5 more'))

  section('§A tool.attempt: the error as a value')
  const a1 = await run('owner-A', 'js', 'const r1 = await tool.attempt.Read({ file_path: "/x" })\nconst r2 = await tool.attempt.Refused({})\nconst r3 = await tool.attempt("Grep", { pattern: "x" })\nJSON.stringify([r1, r2, r3])')
  check('A1 the JS cell finishes ok', a1.status === 'ok', JSON.stringify(a1.error ?? a1.annotations))
  check('A2 each outcome is a value', a1.resultRepr === "'[{\"ok\":true,\"value\":\"Read-answer\"},{\"ok\":false,\"error\":\"the bridge refused this call\"},{\"ok\":true,\"value\":\"Grep-answer\"}]'", a1.resultRepr ?? '')
  check('A3 the ledger still names the failed call on an ok cell', (a1.annotations.find(a => a.startsWith('nested calls')) ?? '').includes('2 Refused failed'), JSON.stringify(a1.annotations))
  const a2 = await run('owner-A', 'py', 'r1 = tool.attempt("Read", file_path="/x")\nr2 = tool.attempt("Refused")\n[r1["ok"], r2["ok"], r2["error"]]')
  check('A4 the Python cell finishes ok with values', a2.status === 'ok' && a2.resultRepr === "[True, False, 'the bridge refused this call']", a2.resultRepr ?? JSON.stringify(a2.error))
  const a3 = await run('owner-A', 'py', 'tool("Refused")')
  check('A5 the plain call still raises (a denial must be handled)', a3.status === 'error' && (a3.error?.value ?? '').includes('the bridge refused this call'), JSON.stringify(a3.error))
} finally {
  await evalKernelManager.disposeAll()
  check('no kernel left behind', evalKernelManager.kernelCount() === 0)
  cleanup()
}
finish('CELL-FAILURE-STATE')
