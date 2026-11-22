import { GLYPH } from '../utils/glyphs.js'
import React, { useRef, useState } from 'react'
import { useLoad, usePublish } from '../hooks/effects.js'
import { Box, Text } from '../ink.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { errorMessage } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { setCwd } from '../utils/Shell.js'
import { plural } from '../utils/stringUtils.js'
import {
  cleanupWorktree,
  getCurrentWorktreeSession,
  keepWorktree,
  type WorktreeSession,
} from '../services/worktree.js'
import { Select } from './CustomSelect/index.js'
import Dialog from './design-system/Dialog.js'
import { Spinner } from './Spinner.js'
import { notBuilt } from '../pi/holes.js'
type ExitChoice =
  | 'keep'
  | 'keep-with-tmux'
  | 'keep-kill-tmux'
  | 'remove'
  | 'remove-with-tmux'

type Phase =
  | { kind: 'loading' }
  | { kind: 'asking'; changedFiles: number; commits: number }
  | { kind: 'keeping' }
  | { kind: 'removing' }
  | { kind: 'done' }

async function recordWorktreeExit(): Promise<void> {
  const { saveWorktreeState } = await import('../utils/sessionStorage/logs.js')
  saveWorktreeState(null)
}

export function restoreWorktreeDirectories(
  session: Pick<WorktreeSession, 'originalCwd'>,
  ops: { chdir: (dir: string) => void; setCwd: (dir: string) => void } = {
    chdir: dir => process.chdir(dir),
    setCwd,
  },
): string | null {
  let failure: unknown = null
  try {
    ops.chdir(session.originalCwd)
  } catch (error) {
    logError(error)
    failure = error
  }
  try {
    ops.setCwd(session.originalCwd)
  } catch (error) {
    logError(error)
    if (failure === null) failure = error
  }
  if (failure === null) return null
  return `Could not return to ${session.originalCwd} (${errorMessage(failure)}) — switch back to that folder before continuing.`
}

async function killTmuxSession(name: string): Promise<void> {
  await execFileNoThrow('tmux', ['kill-session', '-t', name])
}

export function WorktreeExitDialog(arg0: {
  onDone: (result?: string, options?: { displayMode?: 'system' }) => void
  onCancel?: () => void
}): React.ReactNode {
  return notBuilt('src/components/WorktreeExitDialog.tsx:67')
}

export default WorktreeExitDialog
