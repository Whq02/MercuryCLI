import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'flow-refusal-words-')))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.chdir(root)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const context = { ...getEmptyToolPermissionContext(), mode: 'flow' as const }
let failures = 0
const cases = [
  ['echo {a,"$(touch injected)"}', 'Bash needs approval for this brace form: it is not a simple command. Run the commands separately with literal arguments.'],
  ['node "$PWD"', 'Bash needs approval for this variable-only argument because its value is unknown. Use its literal path or value.'],
  ['node app.mjs "$PWD/.tmp-out"', 'Bash needs approval for this argument or redirect because its value is unknown. Use literal arguments and paths; set the working directory with cwd.'],
  ['if true; then B=app.mjs; fi; node $B', 'Bash needs approval for $B because its value is unknown. Use its literal path or value.'],
] as const
try {
  for (const [command, expected] of cases) {
    const result = await bashToolHasPermission({ command }, context)
    const ok = result.behavior === 'ask' && result.message === expected
    console.log(`${ok ? 'PASS' : 'FAIL'} ${command}\n${'message' in result ? result.message : ''}`)
    if (!ok) failures++
  }
} finally {
  process.chdir(original)
  rmSync(root, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
