import { join } from 'node:path'
import { check, cleanup, finish, loadEval, refusingBridge, setup } from './lib.js'

const { home, work } = setup()
const { evalCodePermission } = await import('../../src/permissions/rules/shellProtectedPaths.js')
const { evalKernelManager } = await loadEval()
try {
  for (const [code, expected] of [
    ['print("a b".replace("a", "b"))', 'b b'],
    ['print("a/b".replace("/", "-"))', 'a-b'],
    ['print("x\\ny".replace("\\n", " / "))', 'x / y'],
    [String.raw`s = r'\*'; print(s.replace('\\*', '*'))`, '*'],
  ]) {
    const verdict = await evalCodePermission(code!, work)
    check(`string replacement admitted: ${code}`, verdict === null, verdict === null ? undefined : `${verdict.message} — a plain str.replace must not be denied; narrow the filesystem-replace detection in evalCodePermission (src/permissions/rules/shellProtectedPaths.ts)`)
    if (verdict !== null) continue
    const result = await evalKernelManager.runCell({ owner: 'replace-proof', cwd: work, input: { language: 'py', code: code! }, abortSignal: new AbortController().signal, serveBridge: refusingBridge() })
    const replaceRan = result.status === 'ok' && result.stdout.text.trim() === expected
    const replaceDetail = result.stdout.text || result.error?.value
    check('string replacement runs', replaceRan, replaceRan ? replaceDetail : `${replaceDetail ?? ''} — expected stdout ${JSON.stringify(expected)}; look at evalKernelManager.runCell in src/tools/engines/eval-kernels/kernelManager.ts`)
  }
  const target = JSON.stringify(join(home, 'runtime', 'fixture.txt'))
  const source = JSON.stringify(join(work, 'source.txt'))
  for (const code of [
    `import os\nos.replace(${source}, ${target})`,
    `import os as fs\nfs.replace(${source}, ${target})`,
    `from os import replace as move_file\nmove_file(${source}, ${target})`,
    `from pathlib import Path\nPath(${source}).replace(${target})`,
    `from pathlib import Path as P\np = P(${source})\np.replace(${target})`,
    `from pathlib import Path\nPath(${target}).replace(${source})`,
  ]) {
    const verdict = await evalCodePermission(code, work)
    const refused = verdict?.behavior === 'deny'
    check('filesystem replacement refused', refused, refused ? verdict?.message : `${verdict?.message ?? 'no verdict (null)'} — os.replace and Path.replace onto a protected path must be denied; fix evalCodePermission in src/permissions/rules/shellProtectedPaths.ts`)
    const spanNamed = /code at \d+:\d+:/.test(verdict?.message ?? '') && /replace|move_file/.test(verdict?.message ?? '')
    check('refusal names triggering code span', spanNamed, spanNamed ? verdict?.message : `${verdict?.message ?? 'no verdict (null)'} — the denial message must contain "code at LINE:COL:" and the replace or move_file call; fix its wording in evalCodePermission (src/permissions/rules/shellProtectedPaths.ts)`)
  }
} finally {
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('STRING-REPLACE-FLOOR')
