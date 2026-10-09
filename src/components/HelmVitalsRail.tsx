import * as React from 'react'
import { useEffect, useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import {
  getHelmCursor,
  getHelmFocus,
  getHelmVitalsVersion,
  helmRowSig,
  publishHelmRows,
  subscribeHelmFocus,
} from '../utils/cockpit/helmFocus.js'
import { getLiveContextUsage, getLiveContextUsageVersion, subscribeLiveContextUsage } from '../utils/cockpit/index.js'
import { ctxForecastEnabled, ctxGrowthHistory, estimateTurnsToCompact } from '../utils/cockpit/ctxForecast.js'
import { windowSourceUsages } from '../services/providers/providerUsage.js'
import { usagePollTtlMs } from '../services/providers/usageFreshness.js'
import { useProviderUsageOnShow } from '../hooks/useProviderUsageOnShow.js'
import { getUsageRecordVersion, subscribeUsageRecord } from '../services/anthropicLimits.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../services/engine-connector/focusedConnector.js'
import {
  focusedSessionIdOrNull,
  focusedWorkflowRows,
  otherSessionRunnerPids,
  runningWorkflowRows,
  useFocusedWorkRoster,
  useFocusedWorkRows,
} from './tasks/useFocusedWork.js'
import { healthCertSnapshot } from '../utils/cockpit/healthCertSnapshot.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { pidAlive } from '../utils/pidAlive.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { GLYPH, SPARK } from './mercury-ui/glyphs.js'
import { requestCommandDispatch, requestHelmRowActivationByLabel, setHelmCursor } from '../utils/cockpit/helmFocus.js'
import { usageActivityBins } from '../utils/cockpit/usageActivity.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { RailPanel } from './mercury-ui/RailPanel.js'
import { Sparkline, UsageMeter, useNowTick } from './mercury-ui/components.js'
import { CURSOR_NUDGE_MS, AttentionPulse, ValueGlow, WorkingGlyph } from './mercury-ui/LiveGlyphs.js'
import { partitionDiskRuns } from '../tools/WorkflowTool/runManifest.js'
import { useVitals } from '../state/vitalsBus.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  consoleEnabled,
  getConsoleAskCount,
  getConsoleBuffer,
  getConsoleCursor,
  getConsoleEntries,
  getConsolePending,
  getConsoleVersion,
  isConsoleComposing,
  subscribeConsole,
} from '../utils/cockpit/helmConsole.js'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import { buildVitalsModel, type VitalsInput, type VitalsRowSpec, type VitalsSectionSpec } from '../utils/cockpit/helmVitalsModel.js'

const subscribeFocusedRailModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedRailModel = (): string => getFocusedSessionConnector().modelFacts().main

function VitalsRow({
  label,
  index,
  selected,
  width,
  children,
}: {
  label: string
  index: number
  selected: boolean
  width: number
  children: React.ReactNode
}): React.ReactNode {
  return (
    <InteractiveRow
      id={`helm:vitals:${label}`}
      selected={selected}
      onSelect={() => setHelmCursor('vitals', index)}
      onActivate={() => requestHelmRowActivationByLabel('vitals', label)}
      width={width}
      height={1}
    >
      {children}
    </InteractiveRow>
  )
}

function EmptyHint({
  text,
  width,
  selected = false,
  label,
  index,
}: {
  text: string
  width: number
  selected?: boolean
  label?: string
  index?: number
}): React.ReactNode {
  const tok = useMercuryTokens()
  const { accent } = useSessionAccent()
  const body = (
    <Text wrap="truncate-end">
      <Text color={accent}>{selected ? `${GLYPH.prompt} ` : '  '}</Text>
      <Text color={tok.textMuted}>{text}</Text>
    </Text>
  )
  if (label !== undefined && index !== undefined) {
    return (
      <VitalsRow label={label} index={index} selected={selected} width={width}>
        {body}
      </VitalsRow>
    )
  }
  return <Box width={width}>{body}</Box>
}

export const HelmVitalsRail = React.memo(HelmVitalsRailImpl)

function HelmVitalsRailImpl({ width, availRows }: { width: number; availRows?: number }): React.ReactNode {
  fluxMark('render:rail-vitals')
  const tok = useMercuryTokens()
  useSyncExternalStore(subscribeHelmFocus, getHelmVitalsVersion, getHelmVitalsVersion)
  const focused = getHelmFocus() === 'vitals'
  const cur = getHelmCursor('vitals')
  const { accent } = useSessionAccent()
  const sessionModel = useSyncExternalStore(subscribeFocusedRailModel, getFocusedRailModel, getFocusedRailModel)
  useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)
  useProviderUsageOnShow(true, sessionModel)
  const { primary: usage, others: otherUsages } = windowSourceUsages({ model: sessionModel })
  const workRoster = useFocusedWorkRoster()
  useSyncExternalStore(subscribeConsole, getConsoleVersion, getConsoleVersion)
  const consoleOn = consoleEnabled()
  const consolePending = consoleOn ? getConsolePending() : null
  const { rows: termRows } = useTerminalSize()
  const now = useNowTick(consolePending ? 1000 : Math.min(30_000, usagePollTtlMs()))
  const readNow = Date.now()
  useSyncExternalStore(subscribeLiveContextUsage, getLiveContextUsageVersion, getLiveContextUsageVersion)
  const ctx = getLiveContextUsage()
  const trace = useVitals().trace
  const workRows = useFocusedWorkRows()
  const runningWf = runningWorkflowRows(workRows)
  const wfDisk = useVitals().workflowsDisk
  const externalWf = React.useMemo(() => {
    const knownRunIds = new Set(focusedWorkflowRows(workRows).map(r => r.workflowRunId ?? ''))
    const otherPids = otherSessionRunnerPids(focusedSessionIdOrNull())
    return partitionDiskRuns(wfDisk, knownRunIds, now, pidAlive).external.filter(m => !otherPids.has(m.ownerPid))
  }, [wfDisk, workRows, now])

  const input: VitalsInput = {
    width,
    availRows,
    termRows,
    sessionModel,
    usage,
    otherUsages,
    workRoster,
    focusedSessionId: focusedSessionIdOrNull(),
    runningWf,
    externalWf,
    ctx,
    ctxTurns: ctx.window > 0 && ctxForecastEnabled() ? estimateTurnsToCompact(ctx.usedPct, ctx.compactAtPct) : null,
    ctxGrowth: ctx.window > 0 ? ctxGrowthHistory() : [],
    activity: usageActivityBins(now),
    trace,
    cert: healthCertSnapshot(),
    console: {
      on: consoleOn,
      composing: consoleOn && isConsoleComposing(),
      buffer: consoleOn ? getConsoleBuffer() : '',
      cursor: consoleOn ? getConsoleCursor() : 0,
      pending: consolePending,
      last: consoleOn ? getConsoleEntries().at(-1) : undefined,
      count: consoleOn ? getConsoleAskCount() : 0,
    },
    now,
    readNow,
    tok,
  }
  const model = buildVitalsModel(input)

  const rowsSig = model.rows.map(helmRowSig).join('|')
  useEffect(() => {
    publishHelmRows('vitals', model.rows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsSig])

  const isOn = (i: number): boolean => focused && cur === i
  const caret = (i: number): React.ReactNode => <Text color={accent}>{isOn(i) ? `${GLYPH.prompt} ` : '  '}</Text>
  const rowW = model.rowW
  let index = 0
  const paintRow = (spec: VitalsRowSpec): React.ReactNode => {
    const row = 'row' in spec ? spec.row : undefined
    const i = row !== undefined ? index++ : -1
    const selectable = (body: React.ReactNode): React.ReactNode =>
      row === undefined ? (
        <Box key={spec.key} width={rowW}>{body}</Box>
      ) : (
        <VitalsRow key={spec.key} label={row.label} index={i} selected={isOn(i)} width={rowW}>
          {body}
        </VitalsRow>
      )
    switch (spec.kind) {
      case 'text':
        return spec.fixed ? (
          <Box key={spec.key} width={rowW} height={1}>
            <Text color={spec.color}>{spec.text}</Text>
          </Box>
        ) : (
          <Box key={spec.key} width={rowW}>
            <Text wrap="truncate-end">
              <Text color={spec.color}>{spec.text}</Text>
            </Text>
          </Box>
        )
      case 'empty':
        return row === undefined ? (
          <EmptyHint key={spec.key} text={spec.text} width={rowW} />
        ) : (
          <EmptyHint key={spec.key} text={spec.text} width={rowW} selected={isOn(i)} label={row.label} index={i} />
        )
      case 'meter':
        return selectable(
          <Text wrap="truncate-end">
            {caret(i)}
            <UsageMeter compact window={spec.window} state="live" value={spec.value} resetIn={spec.resetIn} />
          </Text>,
        )
      case 'spend':
        return selectable(
          <Text wrap="truncate-end">
            {caret(i)}
            <Text color={tok.textMuted}>{'spend '}</Text>
            <Text color={tok.textSecondary}>{spec.value}</Text>
          </Text>,
        )
      case 'ctx':
        return selectable(
          <Text wrap="truncate-end">
            {caret(i)}
            <Text color={tok.textMuted}>{'ctx '}</Text>
            {spec.pct != null ? (
              <ValueGlow value={spec.pct} color={spec.color}>{spec.pctLabel}</ValueGlow>
            ) : (
              <Text color={tok.textMuted}>{'—'}</Text>
            )}
            <Text color={spec.tailColor}>{spec.tail}</Text>
          </Text>,
        )
      case 'spark':
        return (
          <Box key={spec.key} width={rowW}>
            <Text wrap="truncate-end">
              <Text color={tok.textMuted}>{spec.label}</Text>
              <Sparkline values={spec.values} />
            </Text>
          </Box>
        )
      case 'wf':
        return selectable(
          <Text wrap="truncate-end">
            {caret(i)}
            <WorkingGlyph color={spec.asks > 0 ? tok.warning : tok.success} active={spec.asks === 0} />
            <Text> </Text>
            <Text color={tok.textPrimary}>{spec.name}</Text>
            {spec.asks > 0 ? <AttentionPulse>{` ${spec.asks} ask${spec.asks > 1 ? 's' : ''}`}</AttentionPulse> : null}
          </Text>,
        )
      case 'wfdetail':
        return (
          <Box key={spec.key} width={rowW}>
            <Text wrap="truncate-end">
              <Text color={tok.textMuted}>{'    '}</Text>
              <Text color={tok.textMuted}>{spec.text}</Text>
            </Text>
          </Box>
        )
      case 'wfext':
        return selectable(
          <Text wrap="truncate-end">
            {caret(i)}
            <Text color={spec.wedged ? tok.warning : tok.textMuted}>{`${GLYPH.pending} `}</Text>
            <Text color={tok.textPrimary}>{spec.name}</Text>
            <Text color={spec.wedged ? tok.warning : tok.textMuted}>{spec.tail}</Text>
          </Text>,
        )
      case 'health':
        return selectable(
          <Text wrap="truncate-end">
            {caret(i)}
            {spec.verdict !== null ? (
              <Text>
                <Text color={tok.textMuted}>health </Text>
                {spec.verdict === 'certified' ? (
                  <Text color={tok.success}>{GLYPH.check} certified</Text>
                ) : spec.verdict === 'caution' ? (
                  <Text color={tok.warning}>{GLYPH.warn} caution</Text>
                ) : (
                  <Text color={tok.failure}>{GLYPH.fail} fault</Text>
                )}
                <Text color={spec.stale ? tok.warning : tok.textMuted}>{` · ${spec.age}${spec.stale ? ' stale' : ''}`}</Text>
              </Text>
            ) : (
              <Text color={tok.textMuted}>{`${GLYPH.read} no cert · /health`}</Text>
            )}
          </Text>,
        )
      case 'healthAlert':
        return (
          <Box key={spec.key} width={rowW}>
            <Text wrap="truncate-end">
              <Text color={tok.textMuted}>{'  '}</Text>
              {spec.fault ? <Text color={tok.failure}>{`${GLYPH.fail} ${spec.text}`}</Text> : <Text color={tok.textMuted}>{spec.text}</Text>}
            </Text>
          </Box>
        )
      case 'trace':
        return selectable(
          <Text wrap="truncate-end">
            {caret(i)}
            <Text color={tok.textMuted}>{`${spec.clock} `}</Text>
            <Text color={spec.bad ? tok.failure : tok.textPrimary}>{spec.tool}</Text>
          </Text>,
        )
      case 'consoleInput':
        return selectable(
          spec.composing !== null ? (
            <Text wrap="truncate-end">
              <Text color={accent}>{`${GLYPH.prompt} `}</Text>
              <Text color={tok.textPrimary}>{spec.composing.pre}</Text>
              <Text color={accent}>{GLYPH.caretBlock}</Text>
              <Text color={tok.textSecondary}>{spec.composing.post}</Text>
            </Text>
          ) : (
            <Text wrap="truncate-end">
              {caret(i)}
              {spec.draft ? (
                <Text color={tok.textSecondary}>{spec.draft}</Text>
              ) : (
                <Text color={tok.textMuted}>{isOn(i) ? 'ask — type or ↵' : 'ask anything…'}</Text>
              )}
            </Text>
          ),
        )
      case 'consoleAsking':
        return (
          <Box key={spec.key} width={rowW}>
            <Text wrap="truncate-end">
              <Text color={tok.textMuted}>{'  '}</Text>
              <WorkingGlyph color={tok.success} active />
              <Text> </Text>
              <Text color={tok.textPrimary}>{spec.question}</Text>
              <Text color={tok.textMuted}>{` · ${spec.secs}s`}</Text>
            </Text>
          </Box>
        )
      case 'consoleLine':
        return (
          <Box key={spec.key} width={rowW}>
            <Text wrap="truncate-end">
              <Text color={tok.textMuted}>{'  '}</Text>
              {spec.tone === 'question' ? (
                <Text color={tok.textMuted}>{spec.text}</Text>
              ) : spec.tone === 'answer' ? (
                <Text color={tok.textPrimary}>{spec.text}</Text>
              ) : (
                <Text color={tok.failure}>{spec.tone === 'errorLead' ? `${GLYPH.fail} ` : '  '}{spec.text}</Text>
              )}
            </Text>
          </Box>
        )
    }
  }
  const paintSection = (s: VitalsSectionSpec): React.ReactNode => (
    <RailPanel
      key={s.key}
      glyph={s.key === 'usage' ? SPARK[5] : s.glyph}
      label={s.label}
      count={s.count}
      width={width}
      headerAction={{ id: `helm:panel:${s.key}`, run: () => requestCommandDispatch(s.open) }}
    >
      {s.rows.map(paintRow)}
    </RailPanel>
  )

  return (
    <Box flexDirection="column" width={width}>
      <Box width={width} height={1} flexShrink={0}>
        <Text wrap="truncate-end">
          <ValueGlow value={focused} color={focused ? accent : tok.textMuted} ms={CURSOR_NUDGE_MS}>
            {focused ? <Text bold>{`${GLYPH.prompt} `}</Text> : '  '}
          </ValueGlow>
          {focused ? (
            <>
              <Text color={accent} bold>{'vitals'}</Text>
              <Text color={tok.textMuted}>{' · ↑↓ ↵ tab esc'}</Text>
            </>
          ) : (
            <Text color={tok.textMuted}>{'vitals'}</Text>
          )}
        </Text>
      </Box>
      {model.sections.map(paintSection)}
      {model.pointer !== null ? (
        <Box width={width}>
          <Text wrap="truncate-end" color={tok.textMuted}>{model.pointer}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
