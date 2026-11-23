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
  const [phase, setPhase] = useState<Phase>(() =>
    session === null ? { kind: 'done' } : { kind: 'loading' },
  )
  const resultRef = useRef<string | undefined>(
    session === null ? 'No worktree session to exit.' : undefined,
  )
  const reportedRef = useRef(false)
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  usePublish(() => {
    if (phase.kind !== 'done' || reportedRef.current) return
    reportedRef.current = true
    onDoneRef.current(resultRef.current, { displayMode: 'system' })
  }, [phase.kind])

  useLoad(() => {
    mountedRef.current = true
    let stale = false
    if (session === null) {
      return () => {
        stale = true
        mountedRef.current = false
      }
    }

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

      if (stale) return

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

      const isProvenClean = statusOk && changedFiles === 0 && commitsKnown && commits === 0
      if (!isProvenClean) {
        setPhase({ kind: 'asking', changedFiles, commits })
        return
      }

      setPhase({ kind: 'removing' })
      try {
        await cleanupWorktree()
      } catch (error) {
        if (stale) return
        logError(error)
        resultRef.current = `Could not remove worktree at ${session.worktreePath}: ${errorMessage(error)}. Resolve the issue and retry.`
        setPhase({ kind: 'done' })
        return
      }

      if (session.tmuxSessionName) {
        await killTmuxSession(session.tmuxSessionName)
      }
      const restoreNote = restoreWorktreeDirectories(session)
      await recordWorktreeExit()
      if (stale) return
      resultRef.current = appendRestoreNote(
        'Removed the worktree — there was nothing to keep.',
        restoreNote,
      )
      setPhase({ kind: 'done' })
    }

    void probe()
    return () => {
      stale = true
      mountedRef.current = false
    }
  }, [session])

  if (session === null || phase.kind === 'done') {
    return null
  }

  const executeChoice = async (
    choice: ExitChoice,
    counts: { changedFiles: number; commits: number },
  ): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true

    if (choice === 'keep' || choice === 'keep-with-tmux' || choice === 'keep-kill-tmux') {
      setPhase({ kind: 'keeping' })
      try {
        await keepWorktree()
      } catch (error) {
        logError(error)
        if (!mountedRef.current) return
        resultRef.current = `Could not keep worktree at ${session.worktreePath}: ${errorMessage(error)}.`
        setPhase({ kind: 'done' })
        return
      }
      if (choice === 'keep-kill-tmux' && session.tmuxSessionName) {
        await killTmuxSession(session.tmuxSessionName)
      }
      const restoreNote = restoreWorktreeDirectories(session)
      await recordWorktreeExit()
      if (!mountedRef.current) return
      const branchPart = session.worktreeBranch ? ` on branch ${session.worktreeBranch}` : ''
      let summary = `Kept worktree at ${session.worktreePath}${branchPart}.`
      if (choice === 'keep-with-tmux' && session.tmuxSessionName) {
        summary = `Kept worktree at ${session.worktreePath}${branchPart}. Reattach with: tmux attach -t ${session.tmuxSessionName}`
      } else if (choice === 'keep-kill-tmux' && session.tmuxSessionName) {
        summary = `Kept worktree at ${session.worktreePath}${branchPart} and ended tmux session ${session.tmuxSessionName}.`
      }
      resultRef.current = appendRestoreNote(summary, restoreNote)
      setPhase({ kind: 'done' })
      return
    }

    setPhase({ kind: 'removing' })
    try {
      await cleanupWorktree()
    } catch (error) {
      logError(error)
      if (!mountedRef.current) return
      resultRef.current = `Could not remove worktree at ${session.worktreePath}: ${errorMessage(error)}. Resolve the issue and retry.`
      setPhase({ kind: 'done' })
      return
    }

    if (choice === 'remove-with-tmux' && session.tmuxSessionName) {
      await killTmuxSession(session.tmuxSessionName)
    }
    const restoreNote = restoreWorktreeDirectories(session)
    await recordWorktreeExit()
    if (!mountedRef.current) return

    const discarded: string[] = []
    if (counts.commits > 0) {
      const commitPart = `${counts.commits} ${plural(counts.commits, 'commit')}`
      discarded.push(
        session.worktreeBranch ? `${commitPart} on ${session.worktreeBranch}` : commitPart,
      )
    }
    if (counts.changedFiles > 0) {
      discarded.push(`${counts.changedFiles} uncommitted ${plural(counts.changedFiles, 'change')}`)
    }
    const target = session.tmuxSessionName ? 'worktree and tmux session' : 'worktree'
    const summary =
      discarded.length > 0
        ? `Removed ${target} (discarded ${discarded.join(' and ')}).`
        : `Removed the ${target} — there was nothing to keep.`
    resultRef.current = appendRestoreNote(summary, restoreNote)
    setPhase({ kind: 'done' })
  }

  if (phase.kind === 'loading') {
    return (
      <Box>
        <Spinner />
        <Text>Checking worktree status…</Text>
      </Box>
    )
  }

  if (phase.kind === 'keeping') {
    return (
      <Box>
        <Spinner />
        <Text>Keeping the worktree…</Text>
      </Box>
    )
  }

  if (phase.kind === 'removing') {
    return (
      <Box>
        <Spinner />
        <Text>Removing the worktree…</Text>
      </Box>
    )
  }

  const counts = { changedFiles: phase.changedFiles, commits: phase.commits }
  const defaultChoice: ExitChoice = session.tmuxSessionName ? 'keep-with-tmux' : 'keep'
  const options: Array<{ label: string; value: ExitChoice }> = session.tmuxSessionName
    ? [
        { label: 'Keep worktree and tmux session', value: 'keep-with-tmux' },
        { label: 'Keep worktree, kill tmux session', value: 'keep-kill-tmux' },
        { label: 'Remove worktree and tmux session', value: 'remove-with-tmux' },
      ]
    : [
        { label: 'Keep worktree', value: 'keep' },
        { label: 'Remove worktree', value: 'remove' },
      ]

  const stakes: string[] = []
  if (phase.changedFiles > 0) {
    stakes.push(`${phase.changedFiles} uncommitted ${plural(phase.changedFiles, 'file')}`)
  }
  if (phase.commits > 0) {
    stakes.push(`${phase.commits} ${plural(phase.commits, 'commit')}`)
  }
  const stakeText =
    stakes.length > 0
      ? `This worktree has ${stakes.join(' and ')}.`
      : 'Could not verify whether this worktree has unsaved work.'

  const handleCancel = (): void => {
    if (onCancel) {
      onCancel()
    } else {
      void executeChoice(defaultChoice, counts)
    }
  }

  return (
    <Dialog title="Exit worktree?" onCancel={handleCancel}>
      <Box flexDirection="column" gap={1}>
        <Text color="warning">
          {GLYPH.warn} {stakeText}
        </Text>
        <Text dimColor>
          {session.worktreePath}
          {session.worktreeBranch ? ` (${session.worktreeBranch})` : ''}
        </Text>
        <Select<ExitChoice>
          options={options}
          defaultFocusValue={defaultChoice}
          onChange={choice => {
            void executeChoice(choice, counts)
          }}
          onCancel={handleCancel}
        />
      </Box>
    </Dialog>
  )
}

export default WorktreeExitDialog
