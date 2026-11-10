#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)

console.log('the external editor receives the file it was asked to open, and a file name runs nothing')

const scratch = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'editor-path-')))
const bin = join(scratch, 'bin')
const work = join(scratch, 'work')
mkdirSync(bin)
mkdirSync(work)
const recorded = join(scratch, 'argv.json')
const recorder = join(scratch, 'recorder.mjs')
writeFileSync(recorder, "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.STANDIN_ARGV, JSON.stringify(process.argv.slice(2)))\n")
writeFileSync(join(bin, 'standin-editor'), `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`)
writeFileSync(join(bin, 'wrapper-editor'), 'standin-editor --wrapped "$@"\n')
chmodSync(join(bin, 'standin-editor'), 0o755)
chmodSync(join(bin, 'wrapper-editor'), 0o755)
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
process.env.STANDIN_ARGV = recorded
process.env.STANDIN_NOTE = 'two words'
delete process.env.VISUAL
process.chdir(work)

const instances = (await import('../../src/ink/instances.ts')).default
const renderer = new Proxy({}, { get: (_target, name) => (name === 'awaitTerminalQueries' ? async () => undefined : () => undefined) })
instances.set(process.stdout, renderer as never)
const handback = await import('../../src/utils/terminalHandback.ts')
handback.setTerminalHandbackAddonForTest(null)
handback.setTerminalHandbackDescriptorForTest('none')
const { getExternalEditor } = await import('../../src/utils/editor.ts')
const editorModule = (await import('../../src/utils/promptEditor.ts')) as {
  editFileInEditor: (path: string) => Promise<{ content: string | null; error?: string }>
  editorCommandLine?: (executable: string, args: readonly string[], filePath: string, platform?: NodeJS.Platform) => string
}

async function open(editor: string, path: string): Promise<{ argv: string[] | null; content: string | null; error?: string }> {
  process.env.EDITOR = editor
  getExternalEditor.cache.clear?.()
  rmSync(recorded, { force: true })
  const result = await editorModule.editFileInEditor(path)
  return { argv: existsSync(recorded) ? (JSON.parse(readFileSync(recorded, 'utf8')) as string[]) : null, content: result.content, ...(result.error !== undefined ? { error: result.error } : {}) }
}

try {
  if (process.platform === 'win32') {
    console.log('\n§1 and §2 open files whose names Windows cannot hold; skipped here, §3 pins the Windows line')
  } else {
    console.log('\n§1 a hostile file name arrives as one literal argument and runs nothing')
    const hostile: Array<[string, string]> = [
      ['a command substitution', 'agent-$(touch M1).md'],
      ['backticks', 'agent-`touch M2`.md'],
      ['a double quote and semicolons', 'a";touch M3;".md'],
      ['a double quote, spaces and &&', 'a" && touch M4 && ".md'],
      ['a variable', 'cost-$STANDIN_NOTE.md'],
      ['a single quote and spaces', "it's a note.md"],
      ['a newline', 'line\nbreak.md'],
      ['a backslash before a quote', 'tail\\".md'],
    ]
    for (const [label, name] of hostile) {
      const path = join(work, name)
      writeFileSync(path, `body of ${label}\n`)
      const opened = await open('standin-editor', path)
      check(`${label}: the editor receives that path and nothing else`, j(opened.argv) === j([path]) && opened.content === `body of ${label}\n`, `argv ${j(opened.argv)} · content ${j(opened.content)} · error ${opened.error ?? 'none'}`)
    }
    const left = readdirSync(work).filter(entry => /^M\d$/.test(entry))
    check('no file name ran a command (no marker file was made beside the notes)', left.length === 0, `made: ${left.join(', ')}`)

    console.log("\n§2 the editor setting is read as before: its arguments, a variable in it and a wrapper with no #! line")
    const plain = join(work, 'plain note.md')
    writeFileSync(plain, 'plain\n')
    const withArguments = await open('standin-editor --wait --profile work', plain)
    check('an editor with arguments receives them before the path', j(withArguments.argv) === j(['--wait', '--profile', 'work', plain]), j(withArguments.argv))
    const withVariable = await open('standin-editor --note $STANDIN_NOTE', plain)
    check("a variable in the setting's arguments is still expanded by the shell, as one argument", j(withVariable.argv) === j(['--note', 'two words', plain]), j(withVariable.argv))
    const wrapped = await open('wrapper-editor', plain)
    check('a wrapper script without a #! line still runs and hands the path on', j(wrapped.argv) === j(['--wrapped', plain]) && wrapped.content === 'plain\n', `${j(wrapped.argv)} · ${wrapped.error ?? 'no error'}`)
  }

  console.log("\n§3 the command line is the parent's, byte for byte, up to the path's own quoting")
  const build = editorModule.editorCommandLine
  check('the hand-off builds its line in one place', typeof build === 'function')
  if (typeof build === 'function') {
    const parentLine = (executable: string, args: string[], path: string): string => [`"${executable}"`, ...args.map(arg => `"${arg}"`), `"${path}"`].join(' ')
    const settings: Array<[string, string, string[]]> = [
      ['arguments', 'code', ['-w']],
      ['a variable', 'standin-editor', ['--note', '$STANDIN_NOTE']],
      ['a wrapper', '/opt/tools/wrapper-editor', []],
    ]
    const path = '/tmp/work dir/note.md'
    for (const [label, executable, args] of settings) {
      const parent = parentLine(executable, args, path)
      for (const platform of ['darwin', 'linux'] as const) {
        const line = build(executable, args, path, platform)
        check(`${label} on ${platform}: everything before the path is the parent's bytes and the path is single-quoted`, line === `${parent.slice(0, parent.length - path.length - 2)}'${path}'`, `${line} · parent ${parent}`)
      }
      check(`${label} on win32: the whole line is the parent's`, build(executable, args, path, 'win32') === parent, build(executable, args, path, 'win32'))
    }
    check("a single quote in the path closes, escapes and reopens the quoting", build('vim', [], "/tmp/it's.md", 'linux') === `"vim" '/tmp/it'\\''s.md'`, build('vim', [], "/tmp/it's.md", 'linux'))
  }
  const source = readFileSync(join(REPO, 'src/utils/promptEditor.ts'), 'utf8')
  check('the hand-off runs that line through the shell, as before', /const commandLine = editorCommandLine\(editorExe, invocation\.args, filePath\)/.test(source) && /spawn\(commandLine, \{ shell: true, /.test(source))
} finally {
  process.chdir(REPO)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nprove-editor-path-literal: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
