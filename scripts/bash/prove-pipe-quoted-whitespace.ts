import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'pipe-quoted-whitespace-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { rearrangePipeCommand } = await import('../../src/utils/bash/bashPipeCommand.ts')
const { locateGitBash } = await import('../../src/utils/windowsPaths.ts')
const gitBash = process.platform === 'win32' ? locateGitBash() : null
const shell = gitBash !== null && 'path' in gitBash ? gitBash.path : 'bash'
let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const quote = (value: string): string => `'${value.split("'").join("'\\''")}'`
const run = (program: string) => spawnSync(shell, ['--noprofile', '--norc', '-c', program], {
  cwd: scratch,
  encoding: 'utf8',
  timeout: 10_000,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BASH_ENV: '', ENV: '' },
})

try {
  for (const [label, text] of [
    ['two spaces', 'a  b'],
    ['leading and trailing spaces', '   a  b   '],
    ['tabs', 'a\t\tb'],
    ['mixed whitespace', ' \ta \t  b\t '],
    ['only whitespace', ' \t  \t '],
    ['empty argument', ''],
    ['quoted apostrophe', "a  '  b"],
    ['Unicode beside spaces', 'é  日'],
  ] as const) {
    const command = `printf %s ${quote(text)} | cat`
    const control = run(command)
    const executed = run(`eval ${rearrangePipeCommand(command)}`)
    check(`${label}: original command prints exact bytes`, control.status === 0 && control.stdout === text, JSON.stringify(control))
    check(`${label}: executed pipeline prints exact bytes`, executed.status === 0 && executed.stdout === text, JSON.stringify(executed))
  }
  const cases: Array<[string, string, string]> = [
    ['double-quoted argument', 'printf %s "a  b" | cat', 'a  b'],
    ['format-string spaces', "printf '  %s  ' word | cat", '  word  '],
    ['spaces in the second pipeline stage', "printf x | printf %s 'a  b'", 'a  b'],
    ['environment assignment', "LABEL='a  b' printenv LABEL | cat", 'a  b\n'],
    ['file indentation', "printf '    %s' indented > fixture.txt && cat fixture.txt | cat", '    indented'],
    ['fallback with parameter expansion', "printf %s 'a  b' | cat; : $$", 'a  b'],
    ['fallback with a newline', "printf %s 'a  b' |\ncat", 'a  b'],
  ]
  for (const [label, command, expected] of cases) {
    const executed = run(`eval ${rearrangePipeCommand(command)}`)
    check(label, executed.status === 0 && executed.stdout === expected, JSON.stringify(executed))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`prove-pipe-quoted-whitespace: ${checks - failures}/${checks} PASS`)
process.exit(failures === 0 ? 0 : 1)
