import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'

import { memoize } from 'lodash-es'

import instances from '../ink/instances.js'
import { subprocessEnv } from './subprocessEnv.js'
import { parseLegacyCommandString } from './resolvedInvocation.js'
import { logForDebugging } from './debug.js'
import { reclaimTerminalAfterChild } from './terminalHandback.js'
import { whichSync } from './which.js'


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

export const getExternalEditor = memoize((): string | undefined => {
  const visual = process.env.VISUAL?.trim()
  if (visual) return visual
  const editor = process.env.EDITOR?.trim()
  if (editor) return editor
  if (process.platform === 'win32') return WINDOWS_DEFAULT_EDITOR
  for (const candidate of EDITOR_CANDIDATES) {
    if (whichSync(candidate) !== null) return candidate
  }
  return undefined
})

export function classifyGuiEditor(editor: string): string | undefined {
  for (const token of editor.split(' ')) {
    const tokenBase = basename(token)
    for (const gui of GUI_EDITORS) {
      if (tokenBase.includes(gui)) return gui
    }
  }
  return undefined
}

function parseEditorCommand(editor: string): { executable: string; args: string[] } {
  const invocation = parseLegacyCommandString(editor)
  if (invocation.executablePath.length > 0) {
    return { executable: invocation.executablePath, args: invocation.args }
  }
  return { executable: editor, args: [] }
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

function quoteForWindowsShell(value: string): string {
  return `"${value}"`
}

export function openFileInExternalEditor(filePath: string, line?: number): boolean {
  const editor = getExternalEditor()
  if (!editor) return false
  const { executable, args } = parseEditorCommand(editor)
  const guiFamily = classifyGuiEditor(editor)

  if (guiFamily !== undefined) {
    const targetArgs = gotoLineArgs(guiFamily, filePath, line)
    let child
    if (process.platform === 'win32') {
      const commandString =
        editor.includes(' ') && existsSync(editor)
          ? [quoteForWindowsShell(editor), ...targetArgs.map(quoteForWindowsShell)].join(' ')
          : [quoteForWindowsShell(executable), ...args.map(quoteForWindowsShell), ...targetArgs.map(quoteForWindowsShell)].join(' ')
      child = spawn(commandString, { windowsHide: true, shell: true, detached: true, stdio: 'ignore', env: subprocessEnv() })
    } else {
      child = spawn(executable, [...args, ...targetArgs], { windowsHide: true, detached: true, stdio: 'ignore', env: subprocessEnv() })
    }
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
    let result
    if (process.platform === 'win32') {
      const commandString = [editor, ...lineArgs, quoteForWindowsShell(filePath)].join(' ')
      result = spawnSync(commandString, { shell: true, windowsHide: false, stdio: 'inherit', env: subprocessEnv() })
    } else {
      result = spawnSync(executable, [...args, ...lineArgs, filePath], { windowsHide: false, stdio: 'inherit', env: subprocessEnv() })
    }
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
