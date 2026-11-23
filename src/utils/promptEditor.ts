import { spawn } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

import instances from '../ink/instances.js'
import { expandPastedTextRefs, formatPastedTextRef, getPastedTextRefNumLines } from '../history.js'
import type { PastedContent } from './config/schema.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { classifyGuiEditor, editorDisplayName, editorRefusalLine, resolveExternalEditor, shownEditorValue, type EditorVariable } from './editor.js'
import { editorInvocationOf, editorShellCommandLine, promptEditorSpawnSpec } from './platform/spawn.js'
import { generateTempFilePath } from './tempfile.js'
import { reclaimTerminalAfterChild } from './terminalHandback.js'
import { passedOver } from './passedOver.js'
import { hostEnv } from './hostEnv.js'


export type EditorResult = {
  content: string | null
  error?: string
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

  const resolved = resolveExternalEditor()
  if (!resolved.ok) {
    if (resolved.reason === 'none') {
      return { content: null }
    }
    return { content: null, error: editorRefusalLine(resolved) }
  }

  const trimmedEditor = resolved.editor.trim()
  const editorCommand =
    trimmedEditor === 'code'
      ? 'code -w'
      : trimmedEditor === 'subl'
        ? 'subl --wait'
        : trimmedEditor

  const invocation = editorInvocationOf(resolved.editor, editorCommand, resolved)
  if (!invocation.executablePath) {
    return { content: null }
  }

  try {
    statSync(filePath)
  } catch (error) {
    return { content: null, error: errorMessage(error) }
  }

  const isGui = classifyGuiEditor(editorCommand) !== undefined
  await instance.awaitTerminalQueries()
  if (isGui) {
    instance.pause()
    instance.suspendStdin()
  } else {
    instance.enterAlternateScreen()
  }

  try {
    const env = hostEnv()
    const comSpec = env.ComSpec || env.COMSPEC
    const spec = promptEditorSpawnSpec(
      invocation.executablePath,
      invocation.args,
      filePath,
      comSpec,
      process.platform,
    )
    const child = spec.shell
      ? spawn(spec.commandLine, {
          shell: true,
          stdio: 'inherit',
          windowsHide: false,
          env: subprocessEnv(),
        })
      : spawn(spec.file, spec.args, {
          stdio: 'inherit',
          windowsHide: false,
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
          env: { ...subprocessEnv(), ...spec.extraEnv },
        })

    const outcome = await new Promise<
      { kind: 'exit'; code: number | null } | { kind: 'error'; error: Error }
    >(resolve => {
      let settled = false
      child.on('error', (error: Error) => {
        if (settled) return
        settled = true
        resolve({ kind: 'error', error })
      })
      child.on('exit', (code: number | null) => {
        if (settled) return
        settled = true
        resolve({ kind: 'exit', code })
      })
    })

    if (outcome.kind === 'error') {
      return { content: null, error: errorMessage(outcome.error) }
    }

    if (outcome.code !== null && outcome.code !== 0) {
      const named = editorNamed(resolved.variable, resolved.editor, invocation.executablePath)
      return { content: null, error: `${named} exited with code ${outcome.code}` }
    }

    try {
      const content = readFileSync(filePath, 'utf8')
      return { content }
    } catch (error) {
      return { content: null, error: errorMessage(error) }
    }
  } catch (error) {
    return { content: null, error: errorMessage(error) }
  } finally {
    reclaimTerminalAfterChild(editorCommand)
    if (isGui) {
      instance.resumeStdin()
      instance.resume()
    } else {
      instance.exitAlternateScreen()
    }
    simulateConsoleFaultAfterHandback()
  }
}

export function editorCommandLine(editorExe: string, args: readonly string[], filePath: string, platform: NodeJS.Platform = process.platform): string {
  return editorShellCommandLine(editorExe, args, filePath, platform)
}

function editorNamed(variable: EditorVariable, value: string, executable: string): string {
  return variable === 'default' ? editorDisplayName(basename(executable)) : `${variable}=${shownEditorValue(value)}`
}

const EDITOR_HANDOVER_FAULT_FLAG = 'MERCURY_EDITOR_HANDOVER_FAULT'

function simulateConsoleFaultAfterHandback(): void {
  const shape = flagEnv(EDITOR_HANDOVER_FAULT_FLAG)?.trim()
  if (shape !== 'read' && shape !== 'mode') return
  const syscall = shape === 'read' ? 'read' : 'setRawMode'
  const fault = Object.assign(new Error(`${syscall} EIO: simulated console fault after the editor hand-back`), { code: 'EIO', syscall })
  logForDebugging(`${EDITOR_HANDOVER_FAULT_FLAG}=${shape}: raising a simulated stdin ${syscall} fault after the editor hand-back`, { level: 'warn' })
  if (shape === 'read') process.stdin.destroy(fault)
  else process.stdin.emit('error', fault)
}

function collapseUnmodifiedPastes(
  editedText: string,
  originalPrompt: string,
  pastedContents: Record<number, PastedContent>,
): string {
  let result = editedText
  for (const paste of Object.values(pastedContents)) {
    if (paste.type !== 'text' || paste.content === '') continue
    const ref = formatPastedTextRef(paste.id, getPastedTextRefNumLines(paste.content))
    if (!originalPrompt.includes(ref)) continue
    if (!result.includes(paste.content)) continue
    result = result.replace(paste.content, () => ref)
  }
  return result
}

export async function editPromptInEditor(
  currentPrompt: string,
  pastedContents?: Record<number, PastedContent>,
): Promise<EditorResult> {
  const tempFile = generateTempFilePath()
  const initialContent = pastedContents
    ? expandPastedTextRefs(currentPrompt, pastedContents)
    : currentPrompt

  writeFileSync(tempFile, initialContent, { encoding: 'utf8', flush: true })
  try {
    const result = await editFileInEditor(tempFile)
    if (result.content === null) {
      return result
    }
    let edited = result.content
    if (edited.endsWith('\n') && !edited.endsWith('\n\n')) {
      edited = edited.slice(0, -1)
    }
    if (pastedContents) {
      edited = collapseUnmodifiedPastes(edited, currentPrompt, pastedContents)
    }
    return { content: edited }
  } finally {
    try {
      unlinkSync(tempFile)
    } catch (error) {
      passedOver(error)
    }
  }
}
