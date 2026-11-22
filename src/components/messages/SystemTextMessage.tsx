import { pathToFileURL } from 'node:url'
import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'
import Link from '../../ink/components/Link.js'
import type {
  SystemMessage,
} from '../../types/message.js'
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js'
import { getGlobalConfig } from '../../utils/config.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { openPath } from '../../utils/browser.js'
import { renderModelName } from '../../services/model/model.js'
import { crossProviderNote } from '../../services/model/modelTransition.js'
import { plural } from '../../utils/stringUtils.js'
import { advisorBlockOf } from '../../utils/messages/noticeRows.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppStateStore } from '../../state/AppState.js'
import { isManageableTask } from '../tasks/taskStatusUtils.js'
import { GLYPH } from '../../utils/glyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { MessageResponse } from '../MessageResponse.js'
import { isTransportRetryNotice } from './nullRenderingAttachments.js'
import { ResumeRecapCard } from './ResumeRecapCard.js'
import { SystemAPIErrorMessage } from './SystemAPIErrorMessage.js'
import { UserNoticeMessage } from './UserNoticeMessage.js'
import { useSelectedMessageBg } from '../messageActions.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

function TurnDurationRow({
  message,
}: {
  message: Extract<SystemMessage, { subtype: 'turn_duration' }>
}): React.ReactNode {
  const store = useAppStateStore()
  const [verb] = useState(
    () =>
      TURN_COMPLETION_VERBS[
        Math.floor(Math.random() * TURN_COMPLETION_VERBS.length)
      ] ?? 'Worked',
  )
  const [backgroundCount] = useState(() => {
    try {
      const tasks = Object.values(store.getState().tasks ?? {})
      return tasks.filter(task => isManageableTask(task)).length
    } catch (error) {
      passedOver(error)
      return 0
    }
  })

  const showDuration = getGlobalConfig().showTurnDuration ?? true
  const hasBudget = message.budgetLimit !== undefined
  if (!showDuration && !hasBudget) return null

  const parts: React.ReactNode[] = []
  if (showDuration) {
    parts.push(
      <Text key="duration">
        {verb} for {formatDuration(message.durationMs)}
      </Text>,
    )
  }
  if (hasBudget && message.budgetLimit !== undefined) {
    const used = message.budgetTokens ?? 0
    const pct = Math.round((used / message.budgetLimit) * 100)
    const belowMinimum = used <= message.budgetLimit
    parts.push(
      <Text key="budget">
        {showDuration ? ' · ' : ''}
        {belowMinimum && pct < 100
          ? `${formatNumber(used)} used (min ✓)`
          : `${formatNumber(used)} / ${formatNumber(message.budgetLimit)} (${pct}%)`}
        {message.budgetNudges ? ` · ${message.budgetNudges} ${plural(message.budgetNudges, 'nudge')}` : ''}
      </Text>,
    )
  }
  return (
    <Text dimColor>
      <Text dimColor>{'╰ '}</Text>
      {parts}
      {backgroundCount > 0 ? (
        <Text dimColor>
          {' '}
          · {backgroundCount} background {plural(backgroundCount, 'task')} still
          running
        </Text>
      ) : null}
    </Text>
  )
}


export function SystemTextMessage(arg0: {
  message: SystemMessage
  addMargin?: boolean
  verbose?: boolean
  isTranscriptMode?: boolean
}): React.ReactNode {
  return notBuilt('src/components/messages/SystemTextMessage.tsx:96')
}

export default SystemTextMessage
