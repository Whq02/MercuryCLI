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
import { notBuilt, type Unbuilt } from '../pi/holes.js'


export type EditorResult = Unbuilt

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
  return notBuilt('src/utils/promptEditor.ts:47')
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
  return notBuilt('src/utils/promptEditor.ts:161')
}
