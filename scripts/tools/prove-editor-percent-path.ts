import { mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const arg = process.argv.indexOf('--source-root')
const root = arg < 0 ? resolve(dirname(fileURLToPath(import.meta.url)), '../..') : resolve(process.argv[arg + 1]!)
const childProcess = await import('node:child_process')
let spawned: { command: string; env: Record<string, string>; shell: boolean } | undefined
mock.module('node:child_process', () => ({ ...childProcess, spawn: (command: string, options: { env: Record<string, string>; shell: boolean }) => {
  spawned = { command, env: options.env, shell: options.shell }
  const child = new EventEmitter()
  queueMicrotask(() => child.emit('exit', 0))
  return child
} }))
const { editorCommandLine, editFileInEditor } = await import(`${root}/src/utils/promptEditor.ts`)
let checks = 0
let failures = 0
const check = (label: string, pass: boolean, actual: string): void => {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}: ${actual}`)
}
const expand = (line: string, env: Record<string, string>): string => line.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? whole)
for (const filePath of [String.raw`C:\work\%NAME%\draft.md`, String.raw`C:\work dir\%NAME%-%OTHER%.md`, String.raw`C:\work\100% complete.md`, String.raw`C:\work\plain.md`]) {
  const line = editorCommandLine('editor.exe', ['--wait'], filePath, 'win32')
  const expanded = expand(line, { NAME: 'wrong-directory', OTHER: 'wrong-file', MERCURY_EDITOR_FILE: filePath })
  const expected = `"editor.exe" "--wait" "${filePath}"`
  check(`Windows passes the literal draft path ${filePath}`, expanded === expected, expanded)
}
const path = String.raw`C:\work\%NAME%.md`
const configured = expand(editorCommandLine('editor.exe', ['--profile', '%NAME%'], path, 'win32'), { NAME: 'work', MERCURY_EDITOR_FILE: path })
check('variables in the editor setting still expand, not variables inside the draft path', configured === `"editor.exe" "--profile" "work" "${path}"`, configured)
const posix = editorCommandLine('editor', [], '/work/%NAME%.md', 'linux')
check('the POSIX path quoting is unchanged', posix === '"editor" \'/work/%NAME%.md\'', posix)

const scratch = mkdtempSync(join(tmpdir(), 'editor-percent-'))
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const instances = (await import(`${root}/src/ink/instances.ts`)).default
const handback = await import(`${root}/src/utils/terminalHandback.ts`)
const { getExternalEditor } = await import(`${root}/src/utils/editor.ts`)
handback.setTerminalHandbackAddonForTest(null)
handback.setTerminalHandbackDescriptorForTest('none')
instances.set(process.stdout, new Proxy({}, { get: (_target, name) => name === 'awaitTerminalQueries' ? async () => undefined : () => undefined }))
try {
  const executable = join(scratch, 'proof-editor.exe')
  const draft = join(scratch, 'draft-%NAME%.md')
  writeFileSync(executable, '')
  writeFileSync(draft, 'draft body\n')
  delete process.env.VISUAL
  process.env.EDITOR = executable
  process.env.NAME = 'wrong-file'
  getExternalEditor.cache.clear?.()
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const result = await editFileInEditor(draft)
  Object.defineProperty(process, 'platform', descriptor)
  check('the real handoff reaches the spawn seam and reads the draft back', result.content === 'draft body\n' && spawned?.shell === true, JSON.stringify(result))
  check('the Windows child receives the literal draft path in its own environment', spawned?.env.MERCURY_EDITOR_FILE === draft, spawned?.env.MERCURY_EDITOR_FILE ?? '(absent)')
  const line = spawned === undefined ? '' : expand(spawned.command, spawned.env)
  check('the actual Windows launch line expands to the literal draft, not NAME', line === `"${executable}" "${draft}"`, line)
} finally {
  Object.defineProperty(process, 'platform', descriptor)
  instances.delete(process.stdout)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)
