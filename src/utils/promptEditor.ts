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


export type EditorResult = {
  content: string | null
  error?: string
}

const WAIT_FLAG_OVERRIDES: Record<string, string> = {
  code: 'code -w',
  subl: 'subl --wait',
}

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

  const guiEditorName = classifyGuiEditor(editor)
  const isTerminalEditor = guiEditorName === undefined

  const editorCommand = WAIT_FLAG_OVERRIDES[editor.trim()] ?? editor
  const invocation = parseLegacyCommandString(editorCommand)
  const editorExe = invocation.executablePath
  if (editorExe === '') {
    return { content: null }
  }
  const commandLine = [`"${editorExe}"`, ...invocation.args.map(arg => `"${arg}"`), `"${filePath}"`].join(' ')

  try {
    if (isTerminalEditor) {
      instance.enterAlternateScreen()
    } else {
      instance.pause()
      instance.suspendStdin()
    }
    try {
      const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
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
      if (isTerminalEditor) {
        instance.exitAlternateScreen()
      } else {
        instance.resumeStdin()
        instance.resume()
      }
    }
  } catch {
    return { content: null }
  }
}

function collapseUnmodifiedPastes(
  editedText: string,
  _originalPrompt: string,
  pastedContents: Record<number, PastedContent>,
): string {
  let result = editedText
  for (const paste of Object.values(pastedContents)) {
    if (paste.type !== 'text') continue
    if (!result.includes(paste.content)) continue
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
  const textForFile = pastedContents ? expandPastedTextRefs(currentPrompt, pastedContents) : currentPrompt
  const tempFilePath = generateTempFilePath()
  writeFileSync(tempFilePath, textForFile, { encoding: 'utf8', flush: true })
  try {
    const result = await editFileInEditor(tempFilePath)
    if (result.content === null) {
      return result
    }
    let content = result.content
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
    }
  }
}
