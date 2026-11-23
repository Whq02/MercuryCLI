#!/usr/bin/env bun
import { check, cleanup, finish, refusingBridge, loadEval, section, setup, within } from './lib.js'

const { work } = setup()
const { evalKernelManager } = await loadEval()

const bridge = refusingBridge()
const hinted = (label: string, cond: boolean, hint: string, detail = ''): void => check(label, cond, cond ? detail : detail ? `${detail} | ${hint}` : hint)
const run = (
  owner: string,
  language: 'py' | 'js',
  code: string,
  extra: Partial<{ reset: boolean; timeoutSeconds: number }> = {},
) =>
  within(
    `${language} cell`,
    60_000,
    evalKernelManager.runCell({
      owner,
      cwd: work,
      input: { language, code, ...extra },
      abortSignal: new AbortController().signal,
      serveBridge: bridge,
    }),
  )

try {
  section('Python: state persists; the last expression is the result')
  const p1 = await run('owner-A', 'py', 'def double(x):\n    return x * 2\nbase = 21\n')
  check('cell 1 ran clean', p1.status === 'ok', JSON.stringify(p1.error ?? p1.annotations))
  const p2 = await run('owner-A', 'py', 'double(base)')
  hinted('cell 2 sees cell 1 state, no re-definition', p2.status === 'ok', 'runCell in src/tools/engines/eval-kernels/kernelManager.ts must reuse the retained Python kernel for the same owner, language and cwd', JSON.stringify(p2.error))
  check('last expression is the result (42)', p2.resultRepr === '42', p2.resultRepr ?? '(none)')

  section('JS: const/function/class/import persist through the transform')
  const j1 = await run('owner-A', 'js', "const greeting = 'hi'\nfunction triple(x) { return x * 3 }\nclass Box { constructor(v) { this.v = v } }\n")
  check('js cell 1 ran clean', j1.status === 'ok', JSON.stringify(j1.error ?? j1.annotations))
  const j2 = await run('owner-A', 'js', 'triple(14)')
  hinted('js function persisted; result captured (42)', j2.status === 'ok' && j2.resultRepr === '42', 'a function declared in one JS cell must stay callable in the next cell of the same kernel (src/tools/engines/eval-kernels/kernelManager.ts runCell)', j2.resultRepr ?? JSON.stringify(j2.error))
  const j3 = await run('owner-A', 'js', "new Box(greeting).v + '!'")
  check("js const + class persisted ('hi!')", j3.status === 'ok' && j3.resultRepr === "'hi!'", j3.resultRepr ?? JSON.stringify(j3.error))
  const j4 = await run('owner-A', 'js', "import { basename } from 'node:path'\nbasename('/a/b/c.txt')")
  check('js static import transformed + usable', j4.status === 'ok' && j4.resultRepr === "'c.txt'", j4.resultRepr ?? JSON.stringify(j4.error))
  const j5 = await run('owner-A', 'js', "basename('/x/y/z.md')")
  check('js imported binding persists to the NEXT cell', j5.status === 'ok' && j5.resultRepr === "'z.md'", j5.resultRepr ?? JSON.stringify(j5.error))

  section('reset isolates one language')
  const r1 = await run('owner-A', 'py', 'base', { reset: true })
  hinted('py reset wipes python state (NameError)', r1.status === 'error' && r1.error?.name === 'NameError', 'reset:true in runCell (src/tools/engines/eval-kernels/kernelManager.ts) must recreate the Python kernel before the cell runs', JSON.stringify(r1.error))
  const r2 = await run('owner-A', 'js', 'triple(2)')
  hinted('js binding SURVIVES a python reset', r2.status === 'ok' && r2.resultRepr === '6', 'a reset recreates only the kernel of the cell language; the JS kernel of the same owner must keep its bindings (src/tools/engines/eval-kernels/kernelManager.ts)', r2.resultRepr ?? JSON.stringify(r2.error))

  section('owner keying keeps sessions apart')
  const o1 = await run('owner-B', 'py', "who = 'B'\nwho")
  check("owner-B's kernel is fresh and its own", o1.status === 'ok' && o1.resultRepr === "'B'", o1.resultRepr)
  const o2 = await run('owner-A', 'py', "'who' in globals()")
  hinted("owner-A's kernel never saw owner-B's state", o2.status === 'ok' && o2.resultRepr === 'False', 'kernels are keyed by owner in src/tools/engines/eval-kernels/kernelManager.ts; owner-B state must not reach the owner-A kernel', o2.resultRepr)

  section('stdout/stderr capture')
  const s1 = await run('owner-A', 'py', "import sys\nprint('to-out')\nprint('to-err', file=sys.stderr)\n")
  check('stdout captured', s1.stdout.text.includes('to-out'), JSON.stringify(s1.stdout))
  check('stderr captured separately', s1.stderr.text.includes('to-err'), JSON.stringify(s1.stderr))
} finally {
  await evalKernelManager.disposeAll()
  hinted('no kernel left behind', evalKernelManager.kernelCount() === 0, 'disposeAll in src/tools/engines/eval-kernels/kernelManager.ts must leave kernelCount at 0')
  cleanup()
}
finish('KERNEL-PERSISTENCE')
