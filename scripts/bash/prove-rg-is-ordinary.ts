import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-rg-ordinary-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { checkReadOnlyConstraints, describeBashNotReadOnly } = await import('../../src/tools/BashTool/readOnlyValidation.ts')
const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) fail = 1
}
const verdict = async (command: string): Promise<string> => (await checkReadOnlyConstraints({ command }, false)).behavior
const why = await describeBashNotReadOnly('rg -n foo src')

console.log(' a Bash rg is an ordinary command; the Grep tool is the read-only road')
check('rg -n foo src is not auto-allowed', await verdict('rg -n foo src') !== 'allow', await verdict('rg -n foo src'))
check('it is not on the list, like any unknown command', why?.kind === 'not-on-list' && why.word === 'rg', JSON.stringify(why))
check('rg --files is not auto-allowed either', await verdict('rg --files') !== 'allow', await verdict('rg --files'))
check('grep -n foo src is still read-only', await verdict('grep -n foo src') === 'allow', await verdict('grep -n foo src'))
check('no ripgrep table remains in the validator sources', !/RIPGREP|ripgrep/.test(src('src/utils/shell/readOnlyCommandValidation.ts') + src('src/tools/BashTool/readOnlyValidation.ts')))
check("no 'rg' spelling remains in the read-only road", !/'rg'/.test(src('src/tools/BashTool/readOnlyValidation.ts')))

rmSync(scratch, { recursive: true, force: true })
console.log(fail === 0 ? ' ✅ RG IS ORDINARY PASS' : ' ❌ RG IS ORDINARY FAILED')
process.exit(fail)
