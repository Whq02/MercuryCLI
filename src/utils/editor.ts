import { spawn, spawnSync } from 'node:child_process'
import { basename } from 'node:path'

import { memoize } from 'lodash-es'

import instances from '../ink/instances.js'
import { subprocessEnv } from './subprocessEnv.js'
import { guiEditorSpawnSpec, parseEditorCommandLine, terminalEditorSpawnSpec } from './platform/spawn.js'
import { logForDebugging } from './debug.js'
import { reclaimTerminalAfterChild } from './terminalHandback.js'
import { hostLookupWorld, resolveExecutable, whichSync, type LookupWorld } from './which.js'
import { hostEnv } from './hostEnv.js'


const EDITOR_CANDIDATES = ['code', 'nano', 'vi']

const WINDOWS_DEFAULT_EDITOR = 'notepad'

const EDITOR_DISPLAY_NAMES: Record<string, string> = {
  code: 'VS Code',
  'code-insiders': 'VS Code Insiders',
  codium: 'VSCodium',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  vim: 'Vim',
  nvim: 'Neovim',
  vi: 'Vi',
  emacs: 'Emacs',
  nano: 'Nano',
  pico: 'Pico',
  micro: 'Micro',
  subl: 'Sublime Text',
  sublime_text: 'Sublime Text',
  zed: 'Zed',
  hx: 'Helix',
  kak: 'Kakoune',
  mate: 'TextMate',
  kate: 'Kate',
  gedit: 'gedit',
  notepad: 'Notepad',
  'notepad++': 'Notepad++',
}

const GENERIC_EDITOR_NAME = 'your editor'

function editorBaseName(token: string): string {
  return basename(token).toLowerCase().replace(/\.(exe|cmd|bat|app)$/, '')
}

export function editorDisplayName(editor: string | null | undefined): string {
  const trimmed = editor?.trim() ?? ''
  if (trimmed === '') return GENERIC_EDITOR_NAME
  const tokens = trimmed.split(/\s+/)
  for (const token of [trimmed, ...tokens]) {
    const known = EDITOR_DISPLAY_NAMES[editorBaseName(token)]
    if (known !== undefined) return known
  }
  const base = editorBaseName(tokens[0] ?? trimmed)
  if (base === '') return GENERIC_EDITOR_NAME
  return base.charAt(0).toUpperCase() + base.slice(1)
}

const PLUS_LINE_EDITORS = /\b(vi|vim|nvim|nano|emacs|pico|micro|helix|hx)\b/
const TERMINAL_EDITORS = /^(?:vi|vim|nvim|nano|emacs|pico|micro|helix|hx|kak)(?![a-z])/

export const getExternalEditor = memoize((): string | undefined => {
  const env = hostEnv()
  const visual = env.VISUAL?.trim()
  if (visual) return visual
  const editor = env.EDITOR?.trim()
  if (editor) return editor
  if (process.platform === 'win32') return WINDOWS_DEFAULT_EDITOR
  for (const candidate of EDITOR_CANDIDATES) {
    if (whichSync(candidate) !== null) return candidate
  }
  return undefined
})

export type EditorVariable = 'VISUAL' | 'EDITOR' | 'default'

function editorVariable(): EditorVariable {
  if (hostEnv().VISUAL?.trim()) return 'VISUAL'
  if (hostEnv().EDITOR?.trim()) return 'EDITOR'
  return 'default'
}

const NON_EDITOR_NAMES = new Set(['true', 'false', ':', 'cat', 'echo', 'printf', 'rem', 'exit'])

type EditorRefusal = {
  ok: false
  reason: 'no-op' | 'missing'
  variable: EditorVariable
  value: string
  executable: string
}

export type EditorResolution =
  | { ok: true; editor: string; variable: EditorVariable; executable: string; args: string[] }
  | { ok: false; reason: 'none' }
  | EditorRefusal

const SHOWN_VALUE_MAX = 13

export function shownEditorValue(value: string, max: number = SHOWN_VALUE_MAX): string {
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export function resolveExternalEditor(
  editor: string | undefined = getExternalEditor(),
  variable: EditorVariable = editorVariable(),
  world: LookupWorld = hostLookupWorld(),
): EditorResolution {
  const value = editor?.trim() ?? ''
  if (value === '') return { ok: false, reason: 'none' }
  const { executable, args } = parseEditorCommand(value, world)
  if (NON_EDITOR_NAMES.has(editorBaseName(executable))) {
    return { ok: false, reason: 'no-op', variable, value, executable }
  }
  if (resolveExecutable(executable, world) === null) {
    return { ok: false, reason: 'missing', variable, value, executable }
  }
  return { ok: true, editor: value, variable, executable, args }
}

export function editorRefusalLine(refusal: EditorRefusal): string {
  const named = refusal.variable === 'default' ? 'the default editor' : `${refusal.variable}=${shownEditorValue(refusal.value)}`
  const remedy = refusal.variable === 'default' ? 'set EDITOR to an editor' : `set ${refusal.variable} to an editor`
  if (refusal.reason === 'no-op') return `${named} is not an editor — ${remedy}`
  return `${named} is not on PATH — ${remedy}`
}

const GUI_EDITOR_ARGS: ReadonlyArray<readonly [name: string, args: (filePath: string, line?: number) => string[]]> = [
  ['code', (filePath, line) => (line !== undefined ? ['--goto', `${filePath}:${line}`] : [filePath])],
  ['codium', (filePath, line) => (line !== undefined ? ['--goto', `${filePath}:${line}`] : [filePath])],
  ['cursor', (filePath, line) => (line !== undefined ? ['--goto', `${filePath}:${line}`] : [filePath])],
  ['windsurf', (filePath, line) => (line !== undefined ? ['--goto', `${filePath}:${line}`] : [filePath])],
  ['subl', (filePath, line) => (line !== undefined ? [`${filePath}:${line}`] : [filePath])],
  ['sublime_text', (filePath, line) => (line !== undefined ? [`${filePath}:${line}`] : [filePath])],
  ['zed', (filePath, line) => (line !== undefined ? [`${filePath}:${line}`] : [filePath])],
  ['atom', (filePath, line) => (line !== undefined ? [`${filePath}:${line}`] : [filePath])],
  ['mate', (filePath, line) => (line !== undefined ? ['-l', String(line), filePath] : [filePath])],
  ['kate', (filePath, line) => (line !== undefined ? ['-l', String(line), filePath] : [filePath])],
  ['gedit', (filePath, line) => (line !== undefined ? [`+${line}`, filePath] : [filePath])],
  ['notepad++', (filePath, line) => (line !== undefined ? [`-n${line}`, filePath] : [filePath])],
  ['notepad', filePath => [filePath]],
]

export function classifyGuiEditor(editor: string): string | undefined {
  for (const token of editor.trim().split(/\s+/)) {
    if (token === '') continue
    const base = editorBaseName(token)
    if (TERMINAL_EDITORS.test(base)) return undefined
    for (const [name] of GUI_EDITOR_ARGS) {
      if (base.includes(name)) return name
    }
  }
  return undefined
}

function parseEditorCommand(editor: string, world: LookupWorld): { executable: string; args: string[] } {
  return parseEditorCommandLine(editor, world)
}

export function openFileInExternalEditor(filePath: string, line?: number): boolean {
  const resolution = resolveExternalEditor()
  if (!resolution.ok) {
    if (resolution.reason !== 'none') {
      logForDebugging(editorRefusalLine(resolution), { level: 'warn' })
    }
    return false
  }

  const guiFamily = classifyGuiEditor(resolution.editor)
  if (guiFamily !== undefined) {
    const entry = GUI_EDITOR_ARGS.find(([name]) => name === guiFamily)
    const targetArgs = entry ? entry[1](filePath, line) : [filePath]
    const spec = guiEditorSpawnSpec(resolution.editor, resolution.executable, resolution.args, targetArgs)
    try {
      const child = spec.shell
        ? spawn(spec.command, {
            detached: true,
            stdio: 'ignore',
            shell: true,
            windowsHide: true,
            env: subprocessEnv(),
          })
        : spawn(spec.file, spec.args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: subprocessEnv(),
          })
      child.on('error', err => {
        logForDebugging(`External editor spawn error: ${String(err)}`, { level: 'warn' })
      })
      child.unref()
      return true
    } catch (err) {
      logForDebugging(`Failed to launch external editor: ${String(err)}`, { level: 'warn' })
      return false
    }
  }

  const renderer = instances.get(process.stdout)
  if (renderer === undefined) return false

  const lineArgs = line !== undefined && PLUS_LINE_EDITORS.test(editorBaseName(resolution.executable)) ? [`+${line}`] : []
  const spec = terminalEditorSpawnSpec(
    resolution.editor,
    resolution.executable,
    resolution.args,
    lineArgs,
    filePath,
  )

  renderer.enterAlternateScreen()
  try {
    const result = spec.shell
      ? spawnSync(spec.command, {
          stdio: 'inherit',
          shell: true,
          windowsHide: false,
          env: subprocessEnv(),
        })
      : spawnSync(spec.file, spec.args, {
          stdio: 'inherit',
          windowsHide: false,
          env: subprocessEnv(),
        })
    if (result.error !== undefined) {
      logForDebugging(`External editor spawn error: ${String(result.error)}`, { level: 'warn' })
      return false
    }
    return true
  } finally {
    reclaimTerminalAfterChild('external editor')
    renderer.exitAlternateScreen()
  }
}
