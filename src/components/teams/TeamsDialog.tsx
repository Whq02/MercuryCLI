// The teams roster dialog: a teammate list and a teammate detail
// view. Statuses re-derive from the team's ON-DISK state on a 1 s tick, so
// the cursor follows the teammate's IDENTITY (its name), never a stale
// index. The dialog registers as an overlay so the cancel handler does not
// intercept Escape — and, having done so, binds Escape itself (the shared
// dialog shell provides that binding); an unbound Escape here is the exact
// dead-affordance class this dialog guards against. Hide/show is NOT
// built, advertised, or key-consumed (item 2 ruling). Kill cleanup
// ALWAYS runs even when the pane kill fails; backend registration is
// ensured WITHOUT subprocess probes — the killing process may be a
// teammate on which detection never ran.

import { randomUUID } from 'node:crypto'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import useInput from '../../ink/hooks/use-input.js'
import { Dialog } from '../design-system/Dialog.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import { useStableSelection } from '../mercury-ui/useStableSelection.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { getTheme } from '../../utils/theme.js'
import {
  removeMemberFromTeam,
  setMemberMode,
  setMultipleMemberModes,
} from '../../utils/swarm/teamHelpers.js'
import {
  getTeammateStatuses,
  type TeamSummary,
  type TeammateStatus,
} from '../../utils/teamDiscovery.js'
import { TEAM_LEAD_NAME, TMUX_COMMAND, getSwarmSocketName } from '../../utils/swarm/constants.js'
import { isPaneBackend } from '../../utils/swarm/backends/types.js'
import {
  ensureBackendsRegistered,
  getBackendByType,
} from '../../utils/swarm/backends/registry.js'
import { isInsideTmux } from '../../utils/swarm/backends/detection.js'
import {
  createModeSetRequestMessage,
  createShutdownRequestMessage,
  writeToMailbox,
} from '../../utils/teammateMailbox.js'
import { unassignTeammateTasks, listTasks, type Task } from '../../utils/tasks.js'
import {
  getModeColor,
  permissionModeFromString,
  permissionModeSymbol,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'
import { getNextPermissionMode } from '../../utils/permissions/getNextPermissionMode.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  AGENT_COLOR_TO_THEME_COLOR,
  type AgentColorName,
} from '../../tools/AgentTool/agentColorManager.js'
import { truncateToWidth } from '../../utils/truncate.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { logForDebugging } from '../../utils/debug.js'

const ROSTER_TICK_MS = 1000
const PROMPT_TRUNCATE_COLUMNS = 80

/** The roster row's permission mode, parsed from its stored spelling. */
function modeOf(status: TeammateStatus): PermissionMode {
  return permissionModeFromString(status.mode ?? 'default')
}

/** Idle is the projection's status verdict, not a separate flag. */
function isIdle(status: TeammateStatus): boolean {
  return status.status === 'idle'
}

/** Kill the pane through the backend that created it, then ALWAYS clean up
 *  membership, tasks, and application state — even when the pane kill
 *  fails. A record with no backend type skips the pane kill and logs why. */
async function killTeammate(
  teamName: string,
  status: TeammateStatus,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): Promise<void> {
  try {
    if (status.backendType && isPaneBackend(status.backendType)) {
      // Registration without subprocess probes; detection may never have
      // run in this process and probing can throw here.
      await ensureBackendsRegistered()
      const useExternalSession = !(await isInsideTmux())
      await getBackendByType(status.backendType).killPane(
        status.tmuxPaneId,
        useExternalSession,
      )
    } else {
      logForDebugging(
        `teams dialog: no backend type for ${status.name} — old team file or in-process teammate; skipping the pane kill`,
      )
    }
  } catch (error) {
    logForDebugging(`teams dialog: pane kill failed for ${status.name}: ${error}`)
  }
  // Cleanup always runs.
  try {
    removeMemberFromTeam(teamName, status.tmuxPaneId)
  } catch (error) {
    logForDebugging(`teams dialog: member removal failed: ${error}`)
  }
  let notificationMessage = `${status.name} was terminated.`
  try {
    const result = await unassignTeammateTasks(
      teamName,
      status.agentId,
      status.name,
      'terminated',
    )
    notificationMessage = result.notificationMessage
  } catch (error) {
    logForDebugging(`teams dialog: task unassignment failed: ${error}`)
  }
  setAppState(prev => {
    const roster = prev.teamContext?.teammates
    if (!roster || !(status.agentId in roster)) return prev
    const nextTeammates = { ...roster }
    delete nextTeammates[status.agentId]
    return {
      ...prev,
      teamContext: { ...prev.teamContext!, teammates: nextTeammates },
      inbox: {
        ...prev.inbox,
        messages: [
          ...prev.inbox.messages,
          {
            id: randomUUID(),
            from: 'system',
            text: JSON.stringify({
              type: 'teammate_terminated',
              message: notificationMessage,
            }),
            timestamp: new Date().toISOString(),
            status: 'pending' as const,
          },
        ],
      },
    }
  })
}

async function requestShutdown(teamName: string, status: TeammateStatus): Promise<void> {
  const payload = createShutdownRequestMessage({
    requestId: `shutdown-${randomUUID().slice(0, 8)}`,
    from: TEAM_LEAD_NAME,
    reason: 'the team lead requested a shutdown',
  })
  await writeToMailbox(
    status.name,
    { from: TEAM_LEAD_NAME, text: JSON.stringify(payload), timestamp: new Date().toISOString() },
    teamName,
  )
}

async function sendModeSet(
  teamName: string,
  teammateName: string,
  mode: PermissionMode,
): Promise<void> {
  const payload = createModeSetRequestMessage({ mode, from: TEAM_LEAD_NAME })
  await writeToMailbox(
    teammateName,
    { from: TEAM_LEAD_NAME, text: JSON.stringify(payload), timestamp: new Date().toISOString() },
    teamName,
  )
}

/** Focus the teammate's pane on the CORRECT server/session — targeting the
 * default one silently no-ops (contract data). */
async function focusPane(status: TeammateStatus): Promise<void> {
  if (!status.backendType || !isPaneBackend(status.backendType)) return
  try {
    if (status.backendType === 'iterm2') {
      await execFileNoThrow('it2', ['session', 'focus', '-s', status.tmuxPaneId])
      return
    }
    if (await isInsideTmux()) {
      await execFileNoThrow(TMUX_COMMAND, ['select-pane', '-t', status.tmuxPaneId])
    } else {
      await execFileNoThrow(TMUX_COMMAND, [
        '-L',
        getSwarmSocketName(),
        'select-pane',
        '-t',
        status.tmuxPaneId,
      ])
    }
  } catch (error) {
    logForDebugging(`teams dialog: pane focus failed for ${status.name}: ${error}`)
  }
}

export function TeamsDialog({
  initialTeams,
  onDone,
}: {
  initialTeams?: TeamSummary[]
  onDone: () => void
}): React.ReactNode {
  const tok = useMercuryTokens()
  const [themeName] = useTheme()
  const setAppState = useSetAppState()
  const teamContext = useAppState((s: AppState) => s.teamContext)
  const bypassAvailable = useAppState(
    (s: AppState) => s.toolPermissionContext.isBypassPermissionsModeAvailable,
  )
  // The team name comes from the first supplied summary; the caller derives
  // the list from application state (no filesystem discovery here).
  const teamName = initialTeams?.[0]?.name ?? teamContext?.teamName

  const [teammateStatuses, setTeammateStatuses] = useState<TeammateStatus[]>(() =>
    teamName ? getTeammateStatuses(teamName) : [],
  )
  const [level, setLevel] = useState<'list' | 'detail'>('list')
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [detailTasks, setDetailTasks] = useState<Task[]>([])

  useRegisterOverlay('teams-dialog')
  const cycleChord = useShortcutDisplay('confirm:cycleMode', 'Confirmation', 'shift+tab')

  const refresh = useCallback((): void => {
    if (teamName) setTeammateStatuses(getTeammateStatuses(teamName))
  }, [teamName])

  // Mode changes made by teammates appear on the 1 s tick.
  useEffect(() => {
    const timer = setInterval(refresh, ROSTER_TICK_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, [refresh])

  const { index, selected, select } = useStableSelection(teammateStatuses, t => t.name)

  const backToList = useCallback((): void => {
    setLevel('list')
    setPromptExpanded(false)
    // Returning to the list always resets the cursor to the first row.
    select(0)
  }, [select])

  // The detail body lists the teammate's tasks (agent id OR name).
  useEffect(() => {
    if (level !== 'detail' || !teamName || !selected) {
      setDetailTasks([])
      return
    }
    let dropped = false
    void listTasks(teamName).then(tasks => {
      if (dropped) return
      setDetailTasks(
        tasks.filter(
          task => task.owner === selected.agentId || task.owner === selected.name,
        ),
      )
    })
    return () => {
      dropped = true
    }
  }, [level, teamName, selected])

  const cycleModes = useCallback((): void => {
    if (!teamName) return
    const contextFor = (mode: PermissionMode) => ({
      ...getEmptyToolPermissionContext(),
      mode,
      isBypassPermissionsModeAvailable: bypassAvailable,
    })
    if (level === 'detail') {
      if (!selected) return
      const current = modeOf(selected)
      const next = getNextPermissionMode(contextFor(current))
      // Stored mode FIRST (the UI reflects it immediately), then the message.
      setMemberMode(teamName, selected.name, next)
      void sendModeSet(teamName, selected.name, next)
      refresh()
      return
    }
    if (teammateStatuses.length === 0) return
    // Tandem cycling: differing modes reset to default; agreeing modes advance.
    const modes = teammateStatuses.map(modeOf)
    const agreed = modes.every(mode => mode === modes[0])
    const next: PermissionMode = agreed
      ? getNextPermissionMode(contextFor(modes[0]!))
      : 'default'
    // One batched write to avoid write races; then a message per teammate.
    setMultipleMemberModes(
      teamName,
      teammateStatuses.map(status => ({ memberName: status.name, mode: next })),
    )
    for (const status of teammateStatuses) {
      void sendModeSet(teamName, status.name, next)
    }
    refresh()
  }, [teamName, level, selected, teammateStatuses, bypassAvailable, refresh])

  useKeybinding('confirm:cycleMode', cycleModes, { context: 'Confirmation' })

  useInput((input, key, event) => {
    if (key.upArrow) {
      if (level === 'list') select(index - 1)
      event.stopImmediatePropagation()
      return
    }
    if (key.downArrow) {
      if (level === 'list') select(index + 1)
      event.stopImmediatePropagation()
      return
    }
    if (key.leftArrow) {
      // Inert at list level.
      if (level === 'detail') backToList()
      event.stopImmediatePropagation()
      return
    }
    if (key.return) {
      if (!selected) return
      if (level === 'list') {
        setLevel('detail')
        setPromptExpanded(false)
      } else {
        // Focus the pane and close.
        void focusPane(selected).then(onDone)
      }
      event.stopImmediatePropagation()
      return
    }
    if (input === 'k') {
      if (!teamName || !selected) return
      const shrunkenLast = teammateStatuses.length - 2
      void killTeammate(teamName, selected, setAppState).then(() => {
        refresh()
        if (level === 'detail') backToList()
        else select(Math.min(index, Math.max(0, shrunkenLast)))
      })
      event.stopImmediatePropagation()
      return
    }
    if (input === 's') {
      if (!teamName || !selected) return
      void requestShutdown(teamName, selected).then(refresh)
      if (level === 'detail') backToList()
      event.stopImmediatePropagation()
      return
    }
    if (input === 'p') {
      if (level === 'detail') {
        setPromptExpanded(true)
        event.stopImmediatePropagation()
        return
      }
      if (!teamName) return
      const idle = teammateStatuses.filter(isIdle)
      if (idle.length === 0) return
      void Promise.allSettled(
        idle.map(status => killTeammate(teamName, status, setAppState)),
      ).then(() => {
        refresh()
        select(Math.max(0, index - idle.length))
      })
      event.stopImmediatePropagation()
    }
  })

  const theme = getTheme(themeName)
  const tintFor = (status: TeammateStatus): string | undefined => {
    const key = AGENT_COLOR_TO_THEME_COLOR[status.color as AgentColorName]
    return key ? (theme[key] as string) : undefined
  }

  const header = teamName
    ? `${teamName} — ${teammateStatuses.length} teammate${teammateStatuses.length === 1 ? '' : 's'}`
    : 'team'

  const listFooter = `↑↓ select · enter open · k kill · s shutdown · p prune idle · ${cycleChord} cycle modes · esc close`
  const promptTooLong =
    (selected?.prompt ?? '') !== '' &&
    truncateToWidth(selected!.prompt!, PROMPT_TRUNCATE_COLUMNS) !== selected!.prompt
  const detailFooter = [
    '← back',
    'enter focus',
    'k kill',
    's shutdown',
    ...(promptTooLong && !promptExpanded ? ['p expand prompt'] : []),
    `${cycleChord} cycle mode`,
    'esc close',
  ].join(' · ')

  return (
    <Box flexDirection="column">
      <Dialog title={header} onCancel={onDone} color="background" hideInputGuide>
        {level === 'list' ? (
          <Box flexDirection="column">
            {teammateStatuses.length === 0 ? (
              <Text dimColor>this team has no teammates</Text>
            ) : (
              teammateStatuses.map((status, rowIndex) => {
                const isSelected = rowIndex === index
                const mode = modeOf(status)
                return (
                  <Text
                    key={status.name}
                    backgroundColor={isSelected ? tok.selection : undefined}
                    dimColor={isIdle(status) && !isSelected}
                  >
                    {/* GLYPH.cursor, not ❯ — the in-row selection cursor is one
                        vocabulary token (❯ is the PROMPT affordance; every
                        navigable view points the same ▸ shape). */}
                    <Text color={tok.accent}>{isSelected ? `${GLYPH.cursor} ` : '  '}</Text>
                    {status.isHidden ? <Text dimColor>⊘ </Text> : null}
                    {isIdle(status) ? <Text dimColor>◌ </Text> : null}
                    <Text color={getModeColor(mode)}>{permissionModeSymbol(mode)}</Text>
                    <Text> @{status.name}</Text>
                    {status.model ? <Text dimColor> ({status.model})</Text> : null}
                  </Text>
                )
              })
            )}
          </Box>
        ) : selected ? (
          <Box flexDirection="column">
            <Text>
              <Text color={getModeColor(modeOf(selected))}>
                {permissionModeSymbol(modeOf(selected))}
              </Text>{' '}
              <Text color={tintFor(selected)} bold>
                @{selected.name}
              </Text>
            </Text>
            {selected.model || selected.worktreePath || selected.cwd ? (
              <Text dimColor>
                {[
                  selected.model,
                  selected.worktreePath
                    ? `worktree ${selected.worktreePath}`
                    : selected.cwd,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : null}
            {detailTasks.length > 0 ? (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>tasks</Text>
                {detailTasks.map(task => (
                  <Text key={task.id}>
                    {task.status === 'completed' ? (
                      <Text color={tok.success}>✓ </Text>
                    ) : (
                      <Text>■ </Text>
                    )}
                    {task.subject}
                  </Text>
                ))}
              </Box>
            ) : null}
            {selected.prompt ? (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>prompt</Text>
                <Text>
                  {promptExpanded
                    ? selected.prompt
                    : truncateToWidth(selected.prompt, PROMPT_TRUNCATE_COLUMNS)}
                </Text>
              </Box>
            ) : null}
          </Box>
        ) : (
          <Text dimColor>this team has no teammates</Text>
        )}
      </Dialog>
      <Text dimColor italic>
        {level === 'list' ? listFooter : detailFooter}
      </Text>
    </Box>
  )
}
