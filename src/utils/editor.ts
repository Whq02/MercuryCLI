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

const GUI_EDITORS = [
  'code',
  'cursor',
  'windsurf',
  'codium',
  'subl',
  'atom',
  'gedit',
  'notepad++',
  'notepad',
]

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
  const visual = hostEnv().VISUAL?.trim()
  if (visual) return visual
  const editor = hostEnv().EDITOR?.trim()
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

export function classifyGuiEditor(editor: string): string | undefined {
  for (const token of editor.split(' ')) {
    const tokenBase = basename(token)
    if (TERMINAL_EDITORS.test(editorBaseName(token))) return undefined
    for (const gui of GUI_EDITORS) {
      if (tokenBase.includes(gui)) return gui
    }
  }
  return undefined
}

function parseEditorCommand(editor: string, world: LookupWorld): { executable: string; args: string[] } {
  return parseEditorCommandLine(editor, world)
}

function gotoLineArgs(guiFamily: string, filePath: string, line?: number): string[] {
  if (line === undefined) return [filePath]
  if (guiFamily === 'code' || guiFamily === 'cursor' || guiFamily === 'windsurf' || guiFamily === 'codium') {
    return ['-g', `${filePath}:${line}`]
  }
  if (guiFamily === 'subl') {
    return [`${filePath}:${line}`]
  }
  return [filePath]
}

export function openFileInExternalEditor(filePath: string, line?: number): boolean {
  const resolved = resolveExternalEditor()
  if (!resolved.ok) {
    if (resolved.reason !== 'none') logForDebugging(`editor refused before any spawn: ${editorRefusalLine(resolved)}`, { level: 'warn' })
    return false
  }
  const { editor, executable, args } = resolved
  const guiFamily = classifyGuiEditor(editor)

  if (guiFamily !== undefined) {
    const targetArgs = gotoLineArgs(guiFamily, filePath, line)
    const spec = guiEditorSpawnSpec(editor, executable, args, targetArgs)
    const child = spec.shell
      ? spawn(spec.command, { windowsHide: true, shell: true, detached: true, stdio: 'ignore', env: subprocessEnv() })
      : spawn(spec.file, spec.args, { windowsHide: true, detached: true, stdio: 'ignore', env: subprocessEnv() })
    child.on('error', err => {
      logForDebugging(`editor spawn failed: ${String(err)}`, { level: 'error' })
    })
    child.unref()
    return true
  }

  const instance = instances.get(process.stdout as NodeJS.WriteStream)
  if (!instance) return false
  const supportsPlusLine = PLUS_LINE_EDITORS.test(basename(executable))
  const lineArgs = line !== undefined && supportsPlusLine ? [`+${line}`] : []
  instance.enterAlternateScreen()
  try {
    const spec = terminalEditorSpawnSpec(editor, executable, args, lineArgs, filePath)
    const result = spec.shell
      ? spawnSync(spec.command, { shell: true, windowsHide: false, stdio: 'inherit', env: subprocessEnv() })
      : spawnSync(spec.file, spec.args, { windowsHide: false, stdio: 'inherit', env: subprocessEnv() })
    if (result.error) {
      logForDebugging(`terminal editor failed: ${String(result.error)}`, { level: 'error' })
      return false
    }
    return true
  } finally {
    reclaimTerminalAfterChild('external editor')
    instance.exitAlternateScreen()
  }
}
