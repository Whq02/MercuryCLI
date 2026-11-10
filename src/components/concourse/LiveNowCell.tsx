import React from 'react'
import { Text } from '../../ink.js'
import { fireDeltaWords } from '../BootSaturnScreen.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { CREW_ASK_WAIT_WORDS } from '../../services/engine-connector/crewFacts.js'
import { concourseWaitCopy, type ConcourseRowV1 } from './contracts.js'
import { askTileCopy, useLiveTile } from './liveTiles.js'


export const LiveNowCell = React.memo(function LiveNowCell({
  row,
  ask,
  brief = false,
}: {
  row: ConcourseRowV1
  ask?: string | undefined
  brief?: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  const live = row.state === 'working' || row.state === 'needs-you' || row.state === 'starting'
  const tiled = live && !brief
  const { now, degraded } = useLiveTile(row.sessionId, row.workspaceDir, tiled)
  const headlessLead = (trail: boolean): React.ReactNode =>
    row.kind === 'headless' ? <Text color={t.textSecondary}>headless{trail ? ' · ' : ''}</Text> : null
  const workflowsLead = (trail: boolean): React.ReactNode =>
    row.workflowsAllowed === true && !brief ? (
      <Text color={t.textSecondary}>workflows allowed{trail ? ' · ' : ''}</Text>
    ) : null
  const hasWorkflows = row.workflowsAllowed === true && !brief
  const hasNextFire = row.scheduleNextFireMs !== undefined && !brief
  const nextFireLead = (trail: boolean): React.ReactNode =>
    row.scheduleNextFireMs !== undefined && !brief ? (
      <Text color={t.textSecondary}>next fire {fireDeltaWords(row.scheduleNextFireMs, Date.now())}{trail ? ' · ' : ''}</Text>
    ) : null
  if (row.state === 'queued') {
    return (
      <Text wrap="truncate-end">
        {headlessLead(true)}
        {workflowsLead(true)}
        {nextFireLead(true)}
        <Text color={t.textMuted}>{concourseWaitCopy(row.waitReason, row.waitDetail)}</Text>
      </Text>
    )
  }
  if (ask !== undefined && ask.length > 0) {
    const question = askTileCopy(row.title, ask)
    return (
      <Text wrap="truncate-end">
        {headlessLead(true)}
        {workflowsLead(true)}
        {nextFireLead(true)}
        <Text color={t.warning}>{CREW_ASK_WAIT_WORDS} · {question}</Text>
      </Text>
    )
  }
  if (row.state === 'needs-you') {
    return (
      <Text wrap="truncate-end">
        {headlessLead(hasWorkflows || hasNextFire || (row.nowLabel ?? '') !== '')}
        {workflowsLead(hasNextFire || (row.nowLabel ?? '') !== '')}
        {nextFireLead((row.nowLabel ?? '') !== '')}
        <Text color={t.warning}>{row.nowLabel ?? ''}</Text>
      </Text>
    )
  }
  if (tiled && !degraded && now.kind !== 'still') {
    return (
      <Text wrap={now.kind === 'streaming' ? 'truncate-start' : 'truncate-end'}>
        {headlessLead(true)}
        {workflowsLead(true)}
        {nextFireLead(true)}
        <Text color={t.textMuted}>{now.kind === 'tool' ? `running ${now.line}` : now.line}</Text>
      </Text>
    )
  }
  return (
    <Text wrap="truncate-end">
      {headlessLead(hasWorkflows || hasNextFire || (row.nowLabel ?? '') !== '' || (tiled && degraded))}
      {workflowsLead(hasNextFire || (row.nowLabel ?? '') !== '' || (tiled && degraded))}
      {nextFireLead((row.nowLabel ?? '') !== '' || (tiled && degraded))}
      {tiled && degraded ? <Text color={t.textMuted}>· </Text> : null}
      <Text color={t.textMuted}>{row.nowLabel ?? ''}</Text>
    </Text>
  )
})
