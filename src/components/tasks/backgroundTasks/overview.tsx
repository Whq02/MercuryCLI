import React from 'react'
import { Box, Text } from '../../../ink.js'
import { useVitals } from '../../../state/vitalsBus.js'
import { useCompactWorkCounts, compactWorkSummaryText } from '../useFocusedWork.js'
import { countOperatorTurns } from '../../../utils/messages/operatorTurns.js'
import { formatSessionCost } from '../../../services/providers/spendSpelling.js'
import { contextFillView, contextPercentLabel } from '../../../services/context/contextFill.js'
import { renderModelName } from '../../../utils/model/model.js'
import { hasSeatLive } from '../../../services/engine-connector/seatLive.js'
import { statusLine } from '../../SwitchboardTagBar.js'
import { formatTokens } from '../../../utils/format.js'
import { KeyValueGrid, SectionHeader, type KVRow } from '../../mercury-ui/components.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'

export function CompactSessionOverview(): React.ReactNode {
  const counts = useCompactWorkCounts()
  const snapshot = useVitals(s => s.sessions)
  const refreshedAt = useVitals(s => s.refreshedAt)
  const git = useVitals(s => s.git)
  const connector = getFocusedSessionConnector()
  const records = connector.records()
  const model = connector.modelFacts()
  const usage = connector.usage()
  const fill = contextFillView(records, model.effective)
  const active = hasSeatLive(connector) ? statusLine(connector.live(), connector.status()) : connector.turnActive() ? 'working' : 'ready'
  const rows: KVRow[] = [
    { k: 'session', v: connector.sessionId() },
    { k: 'project', v: connector.workspace().cwd },
    { k: 'model', v: renderModelName(model.effective) },
    { k: 'effort', v: model.effortSent ?? (model.effort ? `${model.effort} (asked)` : 'unreported') },
    { k: 'permissions', v: connector.permissionMode() ?? 'unreported' },
    { k: 'turns', v: String(countOperatorTurns(records)) },
    { k: 'context', v: contextPercentLabel(fill.usedPct, fill.fillSource) },
    { k: 'tokens in', v: formatTokens(usage.totalInputTokens) },
    { k: 'tokens out', v: formatTokens(usage.totalOutputTokens) },
    { k: 'files', v: `+${usage.totalLinesAdded} / -${usage.totalLinesRemoved} lines` },
  ]
  if (git !== null) rows.push({ k: 'repository', v: `${git.branchName} · ${git.isClean ? 'clean' : 'changed'} · ${git.unpushedCount} unpushed` })
  if (connector.identity().consoleBilling) rows.push({ k: 'cost', v: formatSessionCost(usage.totalCostUSD, usage.unpricedTurns ?? 0) })
  return <Box flexDirection="column">
    <SectionHeader marginTop={0}>Session statistics</SectionHeader>
    <KeyValueGrid rows={rows} keyWidth={12} />
    <SectionHeader>Activity</SectionHeader>
    <Text>{active}</Text>
    <Text>{compactWorkSummaryText(counts, Number.POSITIVE_INFINITY)}</Text>
    <Text dimColor>Sessions are live, unpaused conversations; crewmates and monitors belong to the focused chat.</Text>
    <Text dimColor>{snapshot.state === 'known' ? `Session snapshot: ${snapshot.rows.length} retained records, ${refreshedAt ? new Date(refreshedAt).toLocaleTimeString() : 'not sampled'}` : 'Session snapshot unavailable'}</Text>
  </Box>
}
