import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'

import { memoize } from 'lodash-es'

import instances from '../ink/instances.js'
import { subprocessEnv } from './subprocessEnv.js'
import { parseLegacyCommandString } from './resolvedInvocation.js'
import { logForDebugging } from './debug.js'
import { whichSync } from './which.js'

/**
 * Resolve the user's external editor and launch a file in it — GUI editors
 * detached, terminal editors on the alternate screen.
 */

// On this fork the no-editor fallback prefers the plain terminal editor over
// the classic modal one: nano prints its exit key on screen, while vi gives
// a user with no editor configured no clue it is even accepting input.
const EDITOR_CANDIDATES = ['code', 'nano', 'vi']

// Windows default. The launcher re-quotes the executable and every argument
// before handing the line to a shell, and a quoted `"start"` is a cmd
// BUILTIN spelled as an executable — every /keybindings open on a stock
// box failed with "Start exited with code 1" (TASK-014 w2-f14-05). Notepad
// launched by cmd directly blocks until it closes, so no /wait is needed.
const WINDOWS_DEFAULT_EDITOR = 'notepad'

/**
 * The known GUI editor list, in order — order decides which family a
 * multi-match wins, and the first entry is a substring of the fourth so
 * that fork classifies as the first. Three entries are forks of the first
 * editor that do not share its name.
 */
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

// Terminal editors that accept a `+N` first argument; anything else must
// not receive one (the Windows default would treat `+42` as a filename).
// A WORD-BOUNDARY match against the base name, so a distribution-suffixed
// binary (vim.basic, vim-huge) still qualifies.
const PLUS_LINE_EDITORS = /\b(vi|vim|nvim|nano|emacs|pico|micro|helix|hx)\b/

/**
 * The external editor: VISUAL, else EDITOR (both trimmed, non-blank), else
 * the fixed Windows compound command, else the first available candidate.
 * The availability probe is skipped entirely on Windows because it breaks
 * the process's stdin there.
 */
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

/**
 * Classify a GUI editor: EVERY space-separated token's base name is tested
 * (the Windows default is a compound command whose editor is the LAST
 * token — classifying on token one switched to the alternate buffer and
 * blocked on an invisible notepad). Base-name matching keeps a directory
 * component from producing a false match. Undefined for terminal editors.
 */
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
  // The legacy invocation parser (an executable path plus args), not the
  // shell-quote tokenizer: a quoted or escaped path containing spaces stays
  // one token while extra arguments still propagate.
  const invocation = parseLegacyCommandString(editor)
  if (invocation.executablePath.length > 0) {
    return { executable: invocation.executablePath, args: invocation.args }
  }
  return { executable: editor, args: [] }
}

/** Per-family goto-line argument forms. */
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

/**
 * Launch a file in the external editor. Returns true when an editor was
 * launched. GUI editors spawn detached with ignored stdio; terminal editors
 * run synchronously on the alternate screen with inherited stdio.
 */
export function openFileInExternalEditor(filePath: string, line?: number): boolean {
  const editor = getExternalEditor()
  if (!editor) return false
  const { executable, args } = parseEditorCommand(editor)
  const guiFamily = classifyGuiEditor(editor)

  if (guiFamily !== undefined) {
    // Always spawn the user's actual binary, never the classification
    // result, so variant builds and absolute paths are preserved.
    const targetArgs = gotoLineArgs(guiFamily, filePath, line)
    let child
    if (process.platform === 'win32') {
      // A shell so batch-style launcher scripts resolve; the command string
      // is assembled manually with every token quoted — the shell path
      // joins arguments unquoted, and an unquoted program-files executable
      // ran its first space-separated segment with the error swallowed.
      const commandString =
        editor.includes(' ') && existsSync(editor)
          ? [quoteForWindowsShell(editor), ...targetArgs.map(quoteForWindowsShell)].join(' ')
          : [quoteForWindowsShell(executable), ...args.map(quoteForWindowsShell), ...targetArgs.map(quoteForWindowsShell)].join(' ')
      child = spawn(commandString, { windowsHide: true, shell: true, detached: true, stdio: 'ignore', env: subprocessEnv() })
    } else {
      // An argument array and NO shell: a shell would expand command
      // substitution inside double quotes, and the file path is
      // filesystem-sourced — a malicious repository filename would be a
      // code-execution vector.
      child = spawn(executable, [...args, ...targetArgs], { windowsHide: true, detached: true, stdio: 'ignore', env: subprocessEnv() })
    }
    child.on('error', err => {
      // A missing binary named by the user's environment is a configuration
      // error, not an internal bug; keep it out of error telemetry.
      logForDebugging(`editor spawn failed: ${String(err)}`, { level: 'error' })
    })
    child.unref()
    return true
  }

  // Terminal editor: needs the alternate-screen handoff.
  const instance = instances.get(process.stdout as NodeJS.WriteStream)
  if (!instance) return false
  const supportsPlusLine = PLUS_LINE_EDITORS.test(basename(executable))
  const lineArgs = line !== undefined && supportsPlusLine ? [`+${line}`] : []
  instance.enterAlternateScreen()
  try {
    let result
    if (process.platform === 'win32') {
      // The user's editor string VERBATIM and un-parsed (unlike the GUI
      // path), then the optional +N, then the quoted file path.
      // windowsHide stays FALSE: this child IS the screen — a terminal
      // editor on our own console. `windowsHide: true` is CREATE_NO_WINDOW,
      // which hands the editor a throwaway invisible console instead of
      // ours (the inert-seam class, win32Console.ts).
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
    instance.exitAlternateScreen()
  }
}
