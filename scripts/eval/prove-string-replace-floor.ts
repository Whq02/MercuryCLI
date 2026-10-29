import { join } from 'node:path'
import { check, cleanup, finish, loadEval, refusingBridge, setup } from './lib.js'

const { home, work } = setup()
const { evalCodePermission } = await import('../../src/utils/permissions/shellProtectedPaths.js')
const { evalKernelManager } = await loadEval()
try {
  for (const [code, expected] of [
    ['print("a b".replace("a", "b"))', 'b b'],
    ['print("a/b".replace("/", "-"))', 'a-b'],
    ['print("x\\ny".replace("\\n", " / "))', 'x / y'],
    [String.raw`s = r'\*'; print(s.replace('\\*', '*'))`, '*'],
  ]) {
    const verdict = await evalCodePermission(code!, work)
    check(`string replacement admitted: ${code}`, verdict === null, verdict?.message)
    if (verdict !== null) continue
    const result = await evalKernelManager.runCell({ owner: 'replace-proof', cwd: work, input: { language: 'py', code: code! }, abortSignal: new AbortController().signal, serveBridge: refusingBridge() })
    check('string replacement runs', result.status === 'ok' && result.stdout.text.trim() === expected, result.stdout.text || result.error?.value)
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
    check('filesystem replacement refused', verdict?.behavior === 'deny', verdict?.message)
    check('refusal names triggering code span', /code at \d+:\d+:/.test(verdict?.message ?? '') && /replace|move_file/.test(verdict?.message ?? ''), verdict?.message)
  }
} finally {
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('STRING-REPLACE-FLOOR')
