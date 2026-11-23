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

function appendRestoreNote(message: string, restoreNote: string | null): string {
  return restoreNote ? `${message} ${restoreNote}` : message
}

export function WorktreeExitDialog({
  onDone,
  onCancel,
}: {
  onDone: (result?: string, options?: { displayMode?: 'system' }) => void
  onCancel?: () => void
}): React.ReactNode {
  const [session] = useState<WorktreeSession | null>(() => getCurrentWorktreeSession())
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const statusRef = useRef<{ changedFiles: number; commits: number }>({
    changedFiles: 0,
    commits: 0,
  })
  const resultRef = useRef<string | undefined>(undefined)
  const reportedRef = useRef(false)
  const busyRef = useRef(false)
  const signalRef = useRef<AbortSignal | null>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  usePublish(() => {
    if (phase.kind !== 'done' || reportedRef.current) return
    reportedRef.current = true
    onDoneRef.current(resultRef.current, { displayMode: 'system' })
  }, [phase.kind])

  useLoad(signal => {
    signalRef.current = signal
    if (session === null) return

    const probe = async (): Promise<void> => {
      const statusResult = await execFileNoThrowWithCwd('git', ['status', '--porcelain'], {
        cwd: session.worktreePath,
      })
      const countResult = session.originalHeadCommit
        ? await execFileNoThrowWithCwd(
            'git',
            ['rev-list', '--count', `${session.originalHeadCommit}..HEAD`],
            { cwd: session.worktreePath },
          )
        : null

      if (signal.aborted) return

      const statusOk = statusResult.code === 0
      const changedFiles = statusOk
        ? statusResult.stdout.split('\n').filter(line => line.trim().length > 0).length
        : 0

      let commitsKnown = false
      let commits = 0
      if (countResult !== null && countResult.code === 0) {
        const trimmed = countResult.stdout.trim()
        if (/^\d+$/.test(trimmed)) {
          commits = Number.parseInt(trimmed, 10)
          commitsKnown = true
        }
      }

      statusRef.current = { changedFiles, commits }

      const isProvenClean = statusOk && changedFiles === 0 && commitsKnown && commits === 0
      if (!isProvenClean) {
        setPhase({ kind: 'asking', changedFiles, commits })
        return
      }

      setPhase({ kind: 'removing' })
      try {
        await cleanupWorktree()
        const restoreNote = restoreWorktreeDirectories(session)
        await recordWorktreeExit()
        if (signal.aborted) return
        resultRef.current = appendRestoreNote(
          'Removed the worktree — there was nothing to keep.',
          restoreNote,
        )
      } catch (error) {
        if (signal.aborted) return
        logError(error)
        resultRef.current = `Could not remove ${session.worktreePath}: ${errorMessage(error)}. Fix the error and try again.`
      }
      setPhase({ kind: 'done' })
    }

    void probe()
  }, [session])

  if (session === null) {
    if (!reportedRef.current) {
      reportedRef.current = true
      onDone('No worktree session to exit.', { displayMode: 'system' })
    }
    return null
  }

  if (phase.kind === 'loading' || phase.kind === 'done') {
    return null
  }

  const handleKeep = async (tmuxAction: 'none' | 'keep' | 'kill'): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setPhase({ kind: 'keeping' })
    try {
      if (tmuxAction === 'kill' && session.tmuxSessionName) {
        await killTmuxSession(session.tmuxSessionName)
      }
      await keepWorktree()
      const restoreNote = restoreWorktreeDirectories(session)
      await recordWorktreeExit()
      if (signalRef.current?.aborted) return
      const branchPart = session.worktreeBranch ? ` on ${session.worktreeBranch}` : ''
      let summary = `Work saved at ${session.worktreePath}${branchPart}.`
      if (tmuxAction === 'keep' && session.tmuxSessionName) {
        summary += ` Reattach with: tmux attach -t ${session.tmuxSessionName}`
      } else if (tmuxAction === 'kill') {
        summary += ' The tmux session was terminated.'
      }
      resultRef.current = appendRestoreNote(summary, restoreNote)
    } catch (error) {
      logError(error)
      if (signalRef.current?.aborted) return
      resultRef.current = 'Keeping the worktree failed; exiting anyway.'
    }
    setPhase({ kind: 'done' })
  }

  const handleRemove = async (withTmuxWord: boolean): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setPhase({ kind: 'removing' })
    try {
      if (session.tmuxSessionName) {
        await killTmuxSession(session.tmuxSessionName)
      }
      await cleanupWorktree()
      const restoreNote = restoreWorktreeDirectories(session)
      await recordWorktreeExit()
      if (signalRef.current?.aborted) return
      const status = statusRef.current
      const discarded: string[] = []
      if (status.commits > 0) {
        const branch = session.worktreeBranch || 'the worktree branch'
        discarded.push(`${status.commits} ${plural(status.commits, 'commit')} on ${branch}`)
      }
      if (status.changedFiles > 0) {
        discarded.push('uncommitted changes')
      }
      let summary =
        discarded.length > 0
          ? `Removed the worktree and discarded ${discarded.join(' and ')}.`
          : 'Removed the worktree (nothing to keep).'
      if (withTmuxWord && session.tmuxSessionName) {
        summary += ' The tmux session was terminated.'
      }
      resultRef.current = appendRestoreNote(summary, restoreNote)
    } catch (error) {
      logError(error)
      if (signalRef.current?.aborted) return
      resultRef.current = `Could not remove ${session.worktreePath}: ${errorMessage(error)}. Fix the error and try again.`
    }
    setPhase({ kind: 'done' })
  }

  if (phase.kind === 'keeping') {
    return (
      <Box marginY={1}>
        <Spinner />
        <Text> Keeping the worktree…</Text>
      </Box>
    )
  }

  if (phase.kind === 'removing') {
    return (
      <Box marginY={1}>
        <Spinner />
        <Text> Removing the worktree…</Text>
      </Box>
    )
  }

  const stakes: string[] = []
  if (phase.changedFiles > 0) {
    stakes.push(`${phase.changedFiles} uncommitted ${plural(phase.changedFiles, 'file')}`)
  }
  if (phase.commits > 0) {
    stakes.push(`${phase.commits} ${plural(phase.commits, 'commit')} on the branch`)
  }
  const subtitle =
    stakes.length > 0
      ? `${stakes.join(' and ')} will be lost (and the branch deleted) if the worktree is removed.`
      : 'Keep the worktree around, or clean it up.'
  const removeDescription =
    phase.changedFiles > 0 || phase.commits > 0
      ? 'All changes and commits in the worktree will be lost'
      : 'The worktree directory is cleaned up'

  const defaultChoice: ExitChoice = session.tmuxSessionName ? 'keep-with-tmux' : 'keep'
  const options: Array<{ label: string; value: ExitChoice; description: string }> =
    session.tmuxSessionName
      ? [
          {
            label: 'Keep worktree and tmux session',
            value: 'keep-with-tmux',
            description: `Work stays at ${session.worktreePath}; reattach with: tmux attach -t ${session.tmuxSessionName}`,
          },
          {
            label: 'Keep worktree, kill tmux session',
            value: 'keep-kill-tmux',
            description: `Work stays at ${session.worktreePath}`,
          },
          {
            label: 'Remove worktree and tmux session',
            value: 'remove-with-tmux',
            description: removeDescription,
          },
        ]
      : [
          {
            label: 'Keep worktree',
            value: 'keep',
            description: `Work stays at ${session.worktreePath}`,
          },
          {
            label: 'Remove worktree',
            value: 'remove',
            description: removeDescription,
          },
        ]

  const handleChoice = (choice: ExitChoice): void => {
    if (choice === 'keep') {
      void handleKeep('none')
    } else if (choice === 'keep-with-tmux') {
      void handleKeep('keep')
    } else if (choice === 'keep-kill-tmux') {
      void handleKeep('kill')
    } else if (choice === 'remove') {
      void handleRemove(false)
    } else {
      void handleRemove(true)
    }
  }

  const handleCancel = (): void => {
    if (onCancel) {
      onCancel()
    } else {
      void handleKeep(session.tmuxSessionName ? 'keep' : 'none')
    }
  }

  return (
    <Dialog
      title={`${GLYPH.warn} Exiting a worktree session`}
      subtitle={subtitle}
      onCancel={handleCancel}
    >
      <Select<ExitChoice>
        options={options}
        defaultFocusValue={defaultChoice}
        visibleOptionCount={options.length}
        onChange={handleChoice}
        onCancel={handleCancel}
      />
    </Dialog>
  )
}

export default WorktreeExitDialog
