import figures from 'figures'
import React, { type RefObject } from 'react'
import { Box, Text } from '../../themedRenderer.js'
import type { useSetAppState } from '../../app-state/AppState.js'
import { enterCrewmateView } from '../../../crew/crewmates/crewmateView.js'
import { LEAD_ROW_NAME } from '../../cockpit/crewmateWords.js'
import { CursorRow } from '../../widgets/CursorRow.js'
import { bootRecoveryStatusLine, type getBootRecovery } from '../../../platform/substrate/recoveryOrchestrator.js'
import { isLocalShellTask, type LocalShellTaskState } from '../../../engine/tasks/local-shell/shellTaskState.js'
import { killTask } from '../../../engine/tasks/local-shell/killShellTasks.js'
import { isCrewmateTask, killAsyncCrewmate, type CrewmateTaskState } from '../../../engine/tasks/local-agent/crewmateTask.js'
import type { TaskState } from '../../../engine/tasks/taskState.js'
import { CommandCenter, SectionHeader } from '../../widgets/components.js'
import { WorkingGlyph } from '../../widgets/LiveGlyphs.js'
import { computeSessionWindow } from '../../widgets/faces/SessionManagerView.js'
import type { useMercuryTokens } from '../../widgets/useMercuryTokens.js'
import type { WorkRowV1 } from '../../../engine/connector/types.js'
import { workRowRuns } from '../../../engine/connector/workCounts.js'
import { crewStopHint } from '../../widgets/faces/crewStopChord.js'
import { GLYPH } from '../../theme/glyphs.js'
import type { focusedRunnerPresence } from '../useFocusedWork.js'
import { CrewmateDetailDialog } from '../CrewmateDetailDialog.js'
import { BackgroundTask as BackgroundTaskComponent } from '../BackgroundTask.js'
import { ShellDetailDialog, shellCardFactsOfRow, shellCardFactsOfTask } from '../ShellDetailDialog.js'
import { RosterWorkDetail, type BoardItem, MISSION_IN_PROGRESS_CAP, WorkRowLine, MISSION_PENDING_CAP, WINDOW, SampleRowLine, AgeCell } from './rows.js'
import { CompactSessionOverview } from './overview.js'
import type { MissionTask } from './context.js'

export function taskDetailView({ backFromDetail, detailTask, onDone, setAppState }: { backFromDetail: () => void; detailTask: TaskState; onDone: () => void; setAppState: ReturnType<typeof useSetAppState> }) {
  if (isCrewmateTask(detailTask)) {
    const agent = detailTask as CrewmateTaskState
    return (
      <CommandCenter elevated
        view={`crewmate › ${agent.description !== '' ? agent.description : agent.agentType}`}
        onClose={onDone}
        captureInput={false}
      >
        <CrewmateDetailDialog
          agent={agent}
          onDone={onDone}
          onBack={backFromDetail}
          onKillCrewmate={() => killAsyncCrewmate(agent.id, setAppState)}
          onForeground={() => {
            enterCrewmateView(agent.id, setAppState)
            onDone()
          }}
        />
      </CommandCenter>
    )
  }
  if (isLocalShellTask(detailTask)) {
    const shell = detailTask as LocalShellTaskState
    return (
      <ShellDetailDialog
        shell={shellCardFactsOfTask(shell)}
        onDone={onDone}
        onBack={backFromDetail}
        onKillShell={() => void killTask(shell.id, setAppState)}
      />
    )
  }
}

export function workDetailView({ backFromDetail, detailWork, now, onDone }: { backFromDetail: () => void; detailWork: WorkRowV1; now: number; onDone: () => void }) {
  if (detailWork.kind === 'shell' || (detailWork.kind === 'monitor' && detailWork.command !== undefined)) {
    return (
      <ShellDetailDialog
        shell={shellCardFactsOfRow(detailWork)}
        onDone={onDone}
        onBack={backFromDetail}
      />
    )
  }
  return (
    <CommandCenter elevated
      view={`${detailWork.kind} › ${detailWork.name}`}
      onClose={onDone}
      captureInput={false}
    >
      <RosterWorkDetail work={detailWork} now={now} onBack={backFromDetail} />
    </CommandCenter>
  )
}

export function boardListView({ accent, crewmateTasks, armedWork, bootRecovery, columns, doneMission, flat, inProgress, indexById, leadItems, ledgerOpenCount, missionTasks, now, onDone, pendingMission, presence, selected, selectedIdRef, selectedIndex, summaryEntry, tokens }: { accent: string; crewmateTasks: TaskState[]; armedWork: WorkRowV1 | null; bootRecovery: ReturnType<typeof getBootRecovery>; columns: number; doneMission: MissionTask[]; flat: BoardItem[]; inProgress: MissionTask[]; indexById: Map<string, number>; leadItems: BoardItem[]; ledgerOpenCount: number; missionTasks: ReadonlyArray<MissionTask>; now: number; onDone: () => void; pendingMission: MissionTask[]; presence: ReturnType<typeof focusedRunnerPresence>; selected: BoardItem | undefined; selectedIdRef: RefObject<string | null>; selectedIndex: number; summaryEntry: boolean; tokens: ReturnType<typeof useMercuryTokens> }) {
  const runningCount = flat.filter(item => (item.task ?? item.work)?.status === 'running').length
  const pendingCount = flat.filter(item => (item.task ?? item.work)?.status === 'pending').length
  const activeCount = runningCount + pendingCount
  const subtitle =
    `${activeCount} active` +
    (ledgerOpenCount > 0 ? ` · ${ledgerOpenCount} mission` : '')

  const { start: winStart, end: winEnd } = computeSessionWindow(
    selectedIndex,
    flat.length,
    WINDOW,
  )
  const inWin = (item: BoardItem): boolean => {
    const index = indexById.get(item.id)
    return index !== undefined && index >= winStart && index < winEnd
  }
  const activityWidth = Math.max(30, columns - 26)

  const recoveryLine = bootRecoveryStatusLine(bootRecovery)

  const rowFor = (item: BoardItem): React.ReactNode => {
    const isSelected = item.id === selectedIdRef.current
    if (item.sample !== undefined) {
      return (
        <CursorRow key={item.id} selected={isSelected}>
          <Text bold={isSelected} color={isSelected ? tokens.textPrimary : undefined}>
            {isSelected ? `${figures.pointer} ` : '  '}
          </Text>
          <Box flexGrow={1} minWidth={0}>
            <SampleRowLine sample={item.sample} />
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            <Text color={tokens.textMuted}>↵ opens in your browser</Text>
          </Box>
        </CursorRow>
      )
    }
    if (item.kind === 'lead') {
      return (
        <CursorRow key={item.id} selected={isSelected}>
          <Text bold={isSelected} color={isSelected ? tokens.textPrimary : undefined}>
            {isSelected ? `${figures.pointer} ` : '  '}
          </Text>
          <Box flexGrow={1} minWidth={0}>
            <Text wrap="truncate-end">
              <Text color={accent} bold>{GLYPH.spark} {LEAD_ROW_NAME}</Text>
              <Text color={tokens.textMuted}> · the lead's own chat · ↵ goes back</Text>
            </Text>
          </Box>
        </CursorRow>
      )
    }
    return (
      <CursorRow key={item.id} selected={isSelected}>
        <Text bold={isSelected} color={isSelected ? tokens.textPrimary : undefined}>
          {isSelected ? `${figures.pointer} ` : '  '}
        </Text>
        <Box flexGrow={1} minWidth={0}>
          {item.task !== undefined ? (
            <BackgroundTaskComponent
              task={item.task}
              maxActivityWidth={activityWidth}
            />
          ) : item.work !== undefined ? (
            <WorkRowLine work={item.work} />
          ) : null}
        </Box>
        <AgeCell item={item} now={now} />
      </CursorRow>
    )
  }

  const shellItems = flat.filter(item => item.kind === 'shell')
  const monitorItems = flat.filter(item => item.kind === 'monitor')
  const agentItems = flat.filter(item => item.kind === 'agent')
  const sampleItems = flat.filter(item => item.kind === 'sample')
  const processItems = flat.filter(item => item.kind !== 'sample')

  const selectedStoppable =
    (selected?.task !== undefined && selected.task.status === 'running') ||
    (selected?.work !== undefined && workRowRuns(selected.work))
  const selectedResumable = selected?.work !== undefined && selected.kind === 'agent' && !workRowRuns(selected.work)
  const anyAgentRunning = crewmateTasks.some(task => task.status === 'running')

  const footerParts: string[] = []
  if (flat.length > 0) {
    footerParts.push(
      '↑↓ select',
      'pgup/pgdn page',
      `↵ ${selected?.kind === 'lead' ? `back to ${LEAD_ROW_NAME}` : 'open'}`,
    )
  }
  if (armedWork !== null) footerParts.push(crewStopHint(armedWork.name))
  else if (selectedStoppable) footerParts.push(selected?.work !== undefined ? 'x x stop' : 'x stop')
  if (selectedResumable) footerParts.push('r resume')
  if (anyAgentRunning) footerParts.push('X stop all')
  footerParts.push('esc close')

  return (
    <CommandCenter elevated
      view={summaryEntry ? "activity" : "runs"}
      bodyOwnsPageKeys
      footer={footerParts.join(' · ')}
      subtitle={subtitle}
      onClose={onDone}
      captureInput={false}
    >
      <Box flexDirection="column" tabIndex={-1}>
        {summaryEntry ? <CompactSessionOverview /> : null}
        {missionTasks.length > 0 ? (
          <Box flexDirection="column">
            <SectionHeader marginTop={0} count={ledgerOpenCount}>
              Mission
            </SectionHeader>
            {inProgress.slice(0, MISSION_IN_PROGRESS_CAP).map(task => (
              <Box key={task.id}>
                <WorkingGlyph color={tokens.success} active={true} />
                <Text> {task.activeForm ?? task.subject}</Text>
              </Box>
            ))}
            {inProgress.length > MISSION_IN_PROGRESS_CAP ? (
              <Text dimColor>
                +{inProgress.length - MISSION_IN_PROGRESS_CAP} more in progress
              </Text>
            ) : null}
            {pendingMission.slice(0, MISSION_PENDING_CAP).map(task => (
              <Text key={task.id} dimColor>
                ○ {task.subject}
              </Text>
            ))}
            {pendingMission.length > MISSION_PENDING_CAP ? (
              <Text dimColor>
                +{pendingMission.length - MISSION_PENDING_CAP} more pending
              </Text>
            ) : null}
            {doneMission.length > 0 ? (
              <Text dimColor>{doneMission.length} done</Text>
            ) : null}
          </Box>
        ) : null}

        {processItems.length === 0 ? (
          <Box flexDirection="column" marginTop={missionTasks.length > 0 ? 1 : 0}>
            {ledgerOpenCount === 0 && missionTasks.length === 0 ? (
              <Text dimColor>no mission tasks and no background runs</Text>
            ) : (
              <Text dimColor>no background runs</Text>
            )}
            {presence === 'dormant' ? (
              <Text color={tokens.textMuted}>
                the session has no live runner — ↵ in the chat revives it
              </Text>
            ) : null}
            {recoveryLine !== null ? (
              <Text
                color={
                  recoveryLine.tone === 'ok'
                    ? tokens.success
                    : recoveryLine.tone === 'warn'
                      ? tokens.warning
                      : tokens.textSecondary
                }
              >
                {recoveryLine.text}
              </Text>
            ) : null}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box>
              <Text>
                {runningCount} running
                <Text color={tokens.textMuted}> · </Text>
                {pendingCount} pending
              </Text>
            </Box>
            {winStart > 0 ? (
              <Text dimColor>↑ {winStart} more above</Text>
            ) : null}
            {shellItems.length > 0 ? (
              <Box flexDirection="column">
                <SectionHeader count={shellItems.length}>Shells</SectionHeader>
                {shellItems.filter(inWin).map(rowFor)}
              </Box>
            ) : null}
            {monitorItems.length > 0 ? (
              <Box flexDirection="column">
                <SectionHeader count={monitorItems.length}>
                  Monitors
                </SectionHeader>
                {monitorItems.filter(inWin).map(rowFor)}
              </Box>
            ) : null}
            {agentItems.length > 0 || leadItems.length > 0 ? (
              <Box flexDirection="column">
                <SectionHeader count={agentItems.length}>Crewmates</SectionHeader>
                {leadItems.filter(inWin).map(rowFor)}
                {agentItems.filter(inWin).map(rowFor)}
              </Box>
            ) : null}
            {winEnd < flat.length ? (
              <Text dimColor>↓ {flat.length - winEnd} more</Text>
            ) : null}
          </Box>
        )}
        {sampleItems.length > 0 ? (
          <Box flexDirection="column">
            <SectionHeader count={sampleItems.length}>Samples</SectionHeader>
            {sampleItems.filter(inWin).map(rowFor)}
          </Box>
        ) : null}
      </Box>
    </CommandCenter>
  )
}
