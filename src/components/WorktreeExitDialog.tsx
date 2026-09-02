// Keep or remove the session worktree (and its tmux session) on exit. With
// nothing to keep — no uncommitted changes and no commits on the branch —
// the worktree is removed silently, with no question asked. All shell
// interaction is argv-form, non-throwing capture; the session-storage write
// is reached through a deferred module load because a direct import would
// close an import cycle back through the command layer.

import figures from 'figures'
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../ink.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { logError } from '../utils/log.js'
import { getPlansDirectory } from '../utils/plans.js'
import { setCwd } from '../utils/Shell.js'
import { plural } from '../utils/stringUtils.js'
import {
  cleanupWorktree,
  getCurrentWorktreeSession,
  keepWorktree,
  type WorktreeSession,
} from '../utils/worktree.js'
import { Select } from './CustomSelect/index.js'
import Dialog from './design-system/Dialog.js'
import { Spinner } from './Spinner.js'

/** Contract data for the internal branch logic. */
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
  // Deferred: a direct import would close an import cycle back through the
  // command layer.
  const { saveWorktreeState } = await import('../utils/sessionStorage/logs.js')
  saveWorktreeState(null)
}

function restoreDirectories(session: WorktreeSession): void {
  try {
    process.chdir(session.originalCwd)
  } catch {
    // cleanup/keep already logged; the shell restore below still applies.
  }
  try {
    setCwd(session.originalCwd)
  } catch {
    // A vanished original directory must not block the exit.
  }
}

async function killTmuxSession(name: string): Promise<void> {
  await execFileNoThrow('tmux', ['kill-session', '-t', name])
}

export function WorktreeExitDialog({
  onDone,
  onCancel,
}: {
  onDone: (result?: string, options?: { displayMode?: 'system' }) => void
  onCancel?: () => void
}): React.ReactNode {
  const sessionRef = useRef(getCurrentWorktreeSession())
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const resultRef = useRef<string | undefined>(undefined)
  const reportedRef = useRef(false)

  // The result message is set first and the terminal state second; this
  // effect is what hands the message to the caller.
  useEffect(() => {
    if (phase.kind === 'done' && !reportedRef.current) {
      reportedRef.current = true
      onDone(resultRef.current, { displayMode: 'system' })
    }
  }, [phase, onDone])

  const finish = (message: string): void => {
    resultRef.current = message
    setPhase({ kind: 'done' })
  }

  const removeWorktree = async (withTmux: boolean): Promise<void> => {
    const session = sessionRef.current
    if (!session) return
    setPhase({ kind: 'removing' })
    try {
      if (session.tmuxSessionName) await killTmuxSession(session.tmuxSessionName)
      await cleanupWorktree()
      restoreDirectories(session)
      await recordWorktreeExit()
      getPlansDirectory.cache.clear()
      const parts: string[] = []
      const status = statusRef.current
      if (status.commits > 0) {
        parts.push(
          `${status.commits} ${plural(status.commits, 'commit')} on ${session.worktreeBranch ?? 'the worktree branch'}`,
        )
      }
      if (status.changedFiles > 0) {
        parts.push('uncommitted changes')
      }
      let message =
        parts.length > 0
          ? `Removed the worktree and discarded ${parts.join(' and ')}.`
          : 'Removed the worktree (nothing to keep).'
      if (withTmux && session.tmuxSessionName) {
        message += ' The tmux session was terminated.'
      }
      finish(message)
    } catch (error) {
      logError(error)
      finish('Worktree cleanup failed; exiting anyway.')
    }
  }

  const keepTheWorktree = async (tmux: 'keep' | 'kill' | 'none'): Promise<void> => {
    const session = sessionRef.current
    if (!session) return
    setPhase({ kind: 'keeping' })
    try {
      if (tmux === 'kill' && session.tmuxSessionName) {
        await killTmuxSession(session.tmuxSessionName)
      }
      await keepWorktree()
      restoreDirectories(session)
      await recordWorktreeExit()
      getPlansDirectory.cache.clear()
      let message = `Work saved at ${session.worktreePath}${session.worktreeBranch ? ` on ${session.worktreeBranch}` : ''}.`
      if (tmux === 'keep' && session.tmuxSessionName) {
        message += ` Reattach with: tmux attach -t ${session.tmuxSessionName}`
      } else if (tmux === 'kill') {
        message += ' The tmux session was terminated.'
      }
      finish(message)
    } catch (error) {
      logError(error)
      finish('Keeping the worktree failed; exiting anyway.')
    }
  }

  const statusRef = useRef({ changedFiles: 0, commits: 0 })
  useEffect(() => {
    const session = sessionRef.current
    if (!session) return
    let alive = true
    void (async () => {
      // Porcelain status from the PROCESS working directory.
      const status = await execFileNoThrowWithCwd(
        'git',
        ['status', '--porcelain'],
        { cwd: process.cwd() },
      )
      const changedFiles =
        status.code === 0
          ? status.stdout.split('\n').filter(line => line.trim() !== '').length
          : 0
      let commits = 0
      if (session.originalHeadCommit) {
        const revList = await execFileNoThrowWithCwd(
          'git',
          ['rev-list', '--count', `${session.originalHeadCommit}..HEAD`],
          { cwd: process.cwd() },
        )
        if (revList.code === 0) commits = parseInt(revList.stdout.trim(), 10) || 0
      }
      if (!alive) return
      statusRef.current = { changedFiles, commits }
      if (changedFiles === 0 && commits === 0) {
        // The silent path — no tmux involvement here.
        setPhase({ kind: 'removing' })
        try {
          await cleanupWorktree()
          restoreDirectories(session)
          await recordWorktreeExit()
          getPlansDirectory.cache.clear()
          finish('Removed the worktree — there was nothing to keep.')
        } catch (error) {
          logError(error)
          finish('Worktree cleanup failed; exiting anyway.')
        }
        return
      }
      setPhase({ kind: 'asking', changedFiles, commits })
    })()
    return () => {
      alive = false
    }
  }, [])

  const session = sessionRef.current
  if (!session) {
    // Reported immediately, during render, and nothing renders.
    if (!reportedRef.current) {
      reportedRef.current = true
      onDone('No worktree session to exit.', { displayMode: 'system' })
    }
    return null
  }

  if (phase.kind === 'loading' || phase.kind === 'done') return null

  if (phase.kind === 'keeping' || phase.kind === 'removing') {
    return (
      <Box marginY={1}>
        <Spinner />
        <Text>
          {' '}
          {phase.kind === 'keeping'
            ? 'Keeping the worktree…'
            : 'Removing the worktree…'}
        </Text>
      </Box>
    )
  }

  const { changedFiles, commits } = phase
  const hasTmux = Boolean(session.tmuxSessionName)
  const stakes: string[] = []
  if (changedFiles > 0) {
    stakes.push(`${changedFiles} uncommitted ${plural(changedFiles, 'file')}`)
  }
  if (commits > 0) {
    stakes.push(`${commits} ${plural(commits, 'commit')} on the branch`)
  }
  const subtitle =
    stakes.length > 0
      ? `${stakes.join(' and ')} will be lost (and the branch deleted) if the worktree is removed.`
      : 'Keep the worktree around, or clean it up.'

  const removeDescription =
    changedFiles > 0 || commits > 0
      ? 'All changes and commits in the worktree will be lost'
      : 'The worktree directory is cleaned up'

  const options = hasTmux
    ? [
        {
          label: 'Keep worktree and tmux session',
          value: 'keep-with-tmux' as ExitChoice,
          description: `Work stays at ${session.worktreePath}; reattach with: tmux attach -t ${session.tmuxSessionName}`,
        },
        {
          label: 'Keep worktree, kill tmux session',
          value: 'keep-kill-tmux' as ExitChoice,
          description: `Work stays at ${session.worktreePath}`,
        },
        {
          label: 'Remove worktree and tmux session',
          value: 'remove-with-tmux' as ExitChoice,
          description: removeDescription,
        },
      ]
    : [
        {
          label: 'Keep worktree',
          value: 'keep' as ExitChoice,
          description: `Work stays at ${session.worktreePath}`,
        },
        {
          label: 'Remove worktree',
          value: 'remove' as ExitChoice,
          description: removeDescription,
        },
      ]

  const handleEscape = (): void => {
    if (onCancel) {
      onCancel()
      return
    }
    void keepTheWorktree(hasTmux ? 'keep' : 'none')
  }

  return (
    <Dialog
      title={`${figures.warning} Exiting a worktree session`}
      subtitle={subtitle}
      onCancel={handleEscape}
    >
      <Select
        options={options}
        defaultFocusValue={(hasTmux ? 'keep-with-tmux' : 'keep') as ExitChoice}
        visibleOptionCount={options.length}
        onChange={choice => {
          switch (choice) {
            case 'keep':
              void keepTheWorktree('none')
              break
            case 'keep-with-tmux':
              void keepTheWorktree('keep')
              break
            case 'keep-kill-tmux':
              void keepTheWorktree('kill')
              break
            case 'remove':
            case 'remove-with-tmux':
              void removeWorktree(choice === 'remove-with-tmux')
              break
          }
        }}
        onCancel={handleEscape}
      />
    </Dialog>
  )
}

export default WorktreeExitDialog
