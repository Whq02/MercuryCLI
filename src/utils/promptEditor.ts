import { spawn } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

import instances from '../ink/instances.js'
import { expandPastedTextRefs, formatPastedTextRef, getPastedTextRefNumLines } from '../history.js'
import type { PastedContent } from './config/schema.js'
import { classifyGuiEditor, getExternalEditor } from './editor.js'
import { toIDEDisplayName } from './ide.js'
import { parseLegacyCommandString } from './resolvedInvocation.js'
import { generateTempFilePath } from './tempfile.js'
import { reclaimTerminalAfterChild } from './terminalHandback.js'

/**
 * Hand-off of a file (or the current prompt) to the user's external editor,
 * with terminal-ownership handover around the child process and
 * paste-reference round-tripping for prompt editing.
 */

export type EditorResult = {
  content: string | null
  error?: string
}

/**
 * Editors that need an explicit wait flag before they block until the file
 * is closed. Contract data: without the flag these commands return
 * immediately and the edit session reads the file back unmodified.
 */
const WAIT_FLAG_OVERRIDES: Record<string, string> = {
  code: 'code -w',
  subl: 'subl --wait',
}

// Only one editor session may be open at a time: the terminal handover
// suspends the renderer's input handling and later restores it, and those
// two operations pair by saved state. A second suspend taken while the
// first is outstanding saves an already-suspended (empty) state, so its
// matching restore restores nothing and the terminal is left with input
// permanently detached. Refusing the second call keeps the pairing intact.
let editorSessionActive = false

export async function editFileInEditor(filePath: string): Promise<EditorResult> {
  if (editorSessionActive) {
    return {
      content: null,
      error: 'An editor session is already open. Close it before starting another.',
    }
  }
  editorSessionActive = true
  try {
    return await editFileInEditorInner(filePath)
  } finally {
    editorSessionActive = false
  }
}

async function editFileInEditorInner(filePath: string): Promise<EditorResult> {
  const instance = instances.get(process.stdout)
  if (!instance) {
    throw new Error('Cannot pause rendering: no renderer instance is attached to stdout')
  }

  const editor = getExternalEditor()
  if (editor === undefined || editor.trim() === '') {
    return { content: null }
  }

  try {
    statSync(filePath)
  } catch {
    return { content: null }
  }

  // A GUI editor opens its own window; a terminal editor takes the terminal
  // over. The classifier returns a display name for known GUI editors and
  // nothing for terminal ones.
  const guiEditorName = classifyGuiEditor(editor)
  const isTerminalEditor = guiEditorName === undefined

  // The child is launched through a shell, and a shell splits an unquoted
  // command line on spaces — an editor installed under a path with a space
  // in it would be invoked as its first word only and fail to launch. So
  // the configured command is parsed with the canonical legacy parser and
  // the executable, every argument, and the file path are each re-quoted.
  const editorCommand = WAIT_FLAG_OVERRIDES[editor.trim()] ?? editor
  const invocation = parseLegacyCommandString(editorCommand)
  const editorExe = invocation.executablePath
  if (editorExe === '') {
    return { content: null }
  }
  const commandLine = [`"${editorExe}"`, ...invocation.args.map(arg => `"${arg}"`), `"${filePath}"`].join(' ')

  try {
    if (isTerminalEditor) {
      // The handover must go through the renderer rather than by writing
      // alternate-screen control sequences directly: the renderer may
      // already be IN the alternate screen (fullscreen mode), and a raw
      // "leave alternate screen" on the way out would drop the terminal to
      // the primary buffer under a renderer that still believes it owns
      // the alternate one.
      instance.enterAlternateScreen()
    } else {
      instance.pause()
      instance.suspendStdin()
    }
    try {
      const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
        // windowsHide FALSE: the editor takes over our console; hiding
        // (CREATE_NO_WINDOW) would aim it at an invisible throwaway console.
        const child = spawn(commandLine, { shell: true, windowsHide: false, stdio: 'inherit', env: { ...subprocessEnv() } })
        child.once('error', rejectExit)
        child.once('exit', code => resolveExit(code))
      })
      if (exitCode !== null && exitCode !== 0) {
        return {
          content: null,
          error: `${toIDEDisplayName(basename(editorExe))} exited with code ${exitCode}`,
        }
      }
      return { content: readFileSync(filePath, 'utf8') }
    } finally {
      // A killed editor may have left the terminal's foreground group
      // behind: reclaim it BEFORE either branch re-arms raw mode (a
      // tcsetattr from a background process group is itself a stop).
      reclaimTerminalAfterChild(isTerminalEditor ? 'prompt editor' : 'prompt editor (gui)')
      if (isTerminalEditor) {
        instance.exitAlternateScreen()
      } else {
        instance.resumeStdin()
        instance.resume()
      }
    }
  } catch {
    // Launch failures and read failures surface as an unedited (null)
    // result rather than an exception.
    return { content: null }
  }
}

/**
 * For each recorded text paste whose exact content still appears in the
 * edited text, the first occurrence collapses back to its reference form —
 * restoring the compact display for pastes the user did not modify. The
 * original prompt rides along unread (a retained historical parameter).
 */
function collapseUnmodifiedPastes(
  editedText: string,
  _originalPrompt: string,
  pastedContents: Record<number, PastedContent>,
): string {
  let result = editedText
  for (const paste of Object.values(pastedContents)) {
    if (paste.type !== 'text') continue
    if (!result.includes(paste.content)) continue
    // A function replacer: pasted content may contain dollar-sign patterns
    // the string form of replace would expand.
    result = result.replace(paste.content, () =>
      formatPastedTextRef(paste.id, getPastedTextRefNumLines(paste.content)),
    )
  }
  return result
}

export async function editPromptInEditor(
  currentPrompt: string,
  pastedContents?: Record<number, PastedContent>,
): Promise<EditorResult> {
  // Pasted-text references expand before the write so the user edits real
  // content — but only when the caller supplied a paste record.
  const textForFile = pastedContents ? expandPastedTextRefs(currentPrompt, pastedContents) : currentPrompt
  const tempFilePath = generateTempFilePath()
  writeFileSync(tempFilePath, textForFile, { encoding: 'utf8', flush: true })
  try {
    const result = await editFileInEditor(tempFilePath)
    if (result.content === null) {
      // The already-open refusal and the exit-code error pass through
      // unchanged, error field and all.
      return result
    }
    let content = result.content
    // Editors commonly append a final newline; a single trailing newline is
    // trimmed unless the content deliberately ends with two.
    if (content.endsWith('\n') && !content.endsWith('\n\n')) {
      content = content.slice(0, -1)
    }
    if (pastedContents) {
      content = collapseUnmodifiedPastes(content, currentPrompt, pastedContents)
    }
    return { ...result, content }
  } finally {
    try {
      unlinkSync(tempFilePath)
    } catch {
      // A vanished temp file is not an error.
    }
  }
}
