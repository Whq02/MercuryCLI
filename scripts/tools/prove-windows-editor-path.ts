import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const arg = process.argv.indexOf('--source-root')
const root = arg < 0 ? resolve(dirname(fileURLToPath(import.meta.url)), '../..') : resolve(process.argv[arg + 1]!)
const { resolveExternalEditor } = await import(`${root}/src/utils/editor.ts`)
const { editorCommandLine } = await import(`${root}/src/utils/promptEditor.ts`)
const scratch = mkdtempSync(join(tmpdir(), 'windows-editor-'))
const prior = process.cwd()
process.chdir(scratch)
let checks = 0
let failures = 0
const check = (label: string, pass: boolean, detail = ''): void => {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? `: ${detail}` : ''}`)
}
try {
  const executable = process.platform === 'win32' ? join(scratch, 'Program Files', 'Editor', 'editor.exe') : String.raw`C:\Program Files\Editor\editor.exe`
  mkdirSync(dirname(executable), { recursive: true })
  writeFileSync(executable, '')
  const world = { platform: 'win32', path: scratch }
  for (const [setting, args] of [[executable, []], [`${executable} --wait`, ['--wait']], [`"${executable}" --wait`, ['--wait']]] as const) {
    const selected = resolveExternalEditor(setting, 'EDITOR', world)
    check(`${setting}: resolves the whole executable and arguments`, selected.ok && selected.executable === executable && JSON.stringify(selected.args) === JSON.stringify(args), JSON.stringify(selected))
    const line = selected.ok ? editorCommandLine(selected.executable, selected.args, String.raw`C:\work\draft.md`, 'win32') : ''
    check(`${setting}: the launch starts with the intact quoted path`, line.startsWith(`"${executable}"${args.length ? ' "--wait"' : ''} `), line)
  }
  const bin = join(scratch, 'bin')
  mkdirSync(bin)
  for (const name of ['standin-editor', 'wrapper-editor', 'code', 'subl']) {
    writeFileSync(join(bin, name), '')
    chmodSync(join(bin, name), 0o755)
  }
  const values = [['standin-editor --wait --profile work', 'standin-editor', ['--wait', '--profile', 'work']], ['standin-editor --note $STANDIN_NOTE', 'standin-editor', ['--note', '$STANDIN_NOTE']], ['wrapper-editor', 'wrapper-editor', []], ['code', 'code', []], ['subl', 'subl', []], ['"standin-editor" --wait', 'standin-editor', ['--wait']]] as const
  for (const platform of ['darwin', 'linux']) {
    const unchanged = values.every(([value, expected, args]) => {
      const selected = resolveExternalEditor(value, 'EDITOR', { platform, path: bin })
      return selected.ok && selected.executable === expected && JSON.stringify(selected.args) === JSON.stringify(args)
    })
    check(`${platform}: every existing proof setting keeps its executable and arguments`, unchanged)
  }
  const source = readFileSync(join(root, 'src/utils/promptEditor.ts'), 'utf8')
  check('the Windows handoff uses the resolved executable and arguments without reparsing the path', source.includes('executablePath: resolved.executable, args: resolved.args'))
} finally {
  process.chdir(prior)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)
