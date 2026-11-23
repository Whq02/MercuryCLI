import * as React from 'react'
import { Box, Text } from '../themedRenderer.js'
import { LAYOUT_BREAKPOINTS } from '../fullscreen-layout/useLayoutTier.js'
import { hasConsoleBillingAccess } from '../../models/usage/billing.js'
import type { MissionRowV1 } from '../../engine/connector/types.js'
import type { getLiveContextUsage } from '../cockpit-gauges/index.js'
import { formatCountdown } from '../cockpit-gauges/quota.js'
import { type activeSourceUsage, usageViewIsStale, type UsageWindowView } from '../../models/roads/providerUsage.js'
import { usageAgeTail } from '../../models/roads/usageFreshness.js'
import { EffortChip } from '../widgets/EffortChip.js'
import { TrimChip } from '../widgets/TrimChip.js'
import { MiniCritter } from '../widgets/MiniCritter.js'
import { Crab } from '../widgets/assets.js'
import { ProgressBar, UsageMeter } from '../widgets/components.js'
import { WorkingGlyph } from '../widgets/LiveGlyphs.js'
import { GLYPH, truncateToWidth, branchChip } from '../theme/glyphs.js'
import type { GitRepoState } from '../../platform/git/git.js'
import type { MercuryThemeTokens } from '../theme/mercuryTokens.js'

export function deckPaneView({
  tok,
  TERRA,
  cols,
  compact,
  rawModel,
  model,
  costFigure,
  added,
  removed,
  git,
  tasks,
  sourceUsage,
  stripFirst,
  stripSecond,
  now,
  resetIn,
  ctx,
  ctxUsedK,
  ctxWinLabel,
  ctxRule,
  all,
  completed,
  allDone,
  ordered,
  shown,
  blockedCount,
  ledgerGroups,
  opsRow,
}: {
  tok: MercuryThemeTokens
  TERRA: string
  cols: number
  compact: boolean
  rawModel: string
  model: string
  costFigure: string
  added: number
  removed: number
  git: GitRepoState | null
  tasks: readonly MissionRowV1[] | null
  sourceUsage: ReturnType<typeof activeSourceUsage>
  stripFirst: UsageWindowView
  stripSecond: UsageWindowView
  now: number
  resetIn: (w: { resetsAtMs: number | null }) => string | undefined
  ctx: ReturnType<typeof getLiveContextUsage>
  ctxUsedK: number
  ctxWinLabel: string
  ctxRule: string | undefined
  all: readonly MissionRowV1[]
  completed: MissionRowV1[]
  allDone: boolean
  ordered: MissionRowV1[]
  shown: MissionRowV1[]
  blockedCount: number
  ledgerGroups: [string, { done: number; total: number }][]
  opsRow: React.ReactNode
}): React.ReactNode {
  return (
    <Box
      flexShrink={0}
      flexDirection="column"
      borderStyle="round"
      borderColor={tok.borderStrong}
      paddingX={1}
      width="100%"
    >
      {}
      {compact ? (
        (() => {
          const denseRow = (
            <Text wrap="truncate-end">
              {}
              <Crab />
              <Text color={tok.textMuted}> · </Text>
              <Text color={tok.textSecondary}>{model}</Text>
              <EffortChip model={rawModel} />
              <TrimChip />
              {git !== null ? (
                <>
                  <Text color={tok.textMuted}>{' · ' + branchChip('')}</Text>
                  <Text color={tok.textPrimary}>{truncateToWidth(git.branchName, 14)}</Text>
                  {git.isClean ? null : <Text color={tok.warning}>*</Text>}
                </>
              ) : null}
              {}
              {ctx.window > 0 && ctx.usedPct != null ? (
                <>
                  <Text color={tok.textMuted}> · ctx </Text>
                  <Text color={tok.textSecondary}>{`${ctx.fillSource === 'estimate' ? '≈' : ''}${Math.round(ctx.usedPct)}%`}</Text>
                  <Text color={tok.textMuted}>{` · ${ctxUsedK}k/${ctxWinLabel}`}</Text>
                </>
              ) : null}
            </Text>
          )
          return (
            <Box flexDirection="row">
              <Box flexShrink={0} marginRight={1}>
                <MiniCritter bare />
              </Box>
              <Box flexDirection="column" flexGrow={1}>
                {denseRow}
                {opsRow}
              </Box>
            </Box>
          )
        })()
      ) : (
        <Text wrap="truncate-end">
          <Crab />
          <Text color={tok.textMuted}> · </Text>
          <Text color={tok.textSecondary}>{model}</Text>
          <EffortChip model={rawModel} />
          <TrimChip />
          <Text color={tok.textMuted}> · {hasConsoleBillingAccess() ? `${costFigure} · ` : ''}</Text>
          <Text color={tok.success}>+{added}</Text>
          <Text color={tok.textMuted}>/</Text>
          <Text color={tok.warning}>-{removed}</Text>
        </Text>
      )}

      {}
      {!compact ? (
      <Text wrap="truncate-end">
        {git === null ? (
          <Text color={tok.textMuted}>git: not a repository</Text>
        ) : (
          <>
            <Text color={tok.textMuted}>{branchChip('')}</Text>
            <Text color={tok.textPrimary}>{truncateToWidth(git.branchName, 24)}</Text>
            <Text color={tok.textMuted}> · </Text>
            {git.isClean ? (
              <Text color={tok.success}>clean</Text>
            ) : (
              <Text color={tok.warning}>uncommitted</Text>
            )}
            {}
            {git.unpushedCount > 0 ? (
              <Text color={tok.textSecondary}>{` · ↑${git.unpushedCount}`}</Text>
            ) : !git.isHeadOnRemote ? (
              <Text color={tok.textSecondary}> · ↑</Text>
            ) : null}
            {git.worktreeCount > 1 ? <Text color={tok.textSecondary}>{` · ⌂${git.worktreeCount}`}</Text> : null}
          </>
        )}
        {sourceUsage.windows.length > 0 ? <Text color={tok.textMuted}>{'   ·   '}</Text> : null}
        {stripFirst !== undefined ? (
          <UsageMeter compact window={stripFirst.label} state={stripFirst.state} value={stripFirst.usedPct ?? undefined} resetIn={resetIn({ resetsAtMs: stripFirst.resetsAtMs ?? null })} />
        ) : null}
        {stripSecond !== undefined && cols >= LAYOUT_BREAKPOINTS.cockpitMin ? (
          <>
            <Text color={tok.textMuted}> {GLYPH.dot} </Text>
            <UsageMeter compact window={stripSecond.label} state={stripSecond.state} value={stripSecond.usedPct ?? undefined} resetIn={resetIn({ resetsAtMs: stripSecond.resetsAtMs ?? null })} />
          </>
        ) : null}
        {((): React.ReactNode => {
          const age = stripFirst !== undefined ? usageAgeTail(stripFirst, now) : undefined
          if (age === undefined || stripFirst === undefined) return null
          return (
            <>
              <Text color={tok.textMuted}> {GLYPH.dot} </Text>
              <Text color={usageViewIsStale(stripFirst, now) ? tok.warning : tok.textMuted}>{age}</Text>
            </>
          )
        })()}
        {((): React.ReactNode => {
          if (sourceUsage.limited === undefined) return null
          return (
            <Text>
              <Text color={tok.textMuted}> {GLYPH.dot} </Text>
              <Text color={tok.warning}>{`limit · resets ${formatCountdown(sourceUsage.limited.resetsAtMs - now)}`}</Text>
            </Text>
          )
        })()}
      </Text>
      ) : null}

      {}
      {!compact ? (
      <Text wrap="truncate-end">
        <Text color={tok.textMuted}>{`tasks (${completed.length}/${all.length}) `}</Text>
        {tasks === null ? (
          <Text color={tok.textMuted}>…</Text>
        ) : all.length === 0 ? (
          <Text color={tok.textMuted}>none</Text>
        ) : allDone ? (
          <Text color={tok.success}>{`${GLYPH.done} ${all.length}/${all.length} complete`}</Text>
        ) : (
          shown.map((t, i) => {
            const isActive = t.status === 'in_progress'
            const isDone = t.status === 'completed'
            const label = truncateToWidth(
              isActive ? t.activeForm || t.subject : t.subject,
              32,
            )
            const glyph = isDone ? GLYPH.done : '○'
            const glyphCol = isActive ? TERRA : isDone ? tok.success : tok.textMuted
            const labelCol = isActive ? tok.textPrimary : isDone ? tok.textMuted : tok.textSecondary
            return (
              <Text key={i}>
                {i > 0 ? <Text color={tok.textMuted}> · </Text> : null}
                {isActive ? (
                  <WorkingGlyph color={glyphCol} />
                ) : (
                  <Text color={glyphCol}>{glyph}</Text>
                )}
                <Text bold={isActive} color={glyphCol}>
                  {' '}
                </Text>
                <Text bold={isActive} color={labelCol}>
                  {label}
                </Text>
              </Text>
            )
          })
        )}
        {!allDone && ordered.length > shown.length ? (
          <Text color={tok.textMuted}>{` +${ordered.length - shown.length}`}</Text>
        ) : null}
        {blockedCount > 0 ? (
          <Text color={tok.warning}>{` · ${GLYPH.conflict}${blockedCount} blocked`}</Text>
        ) : null}
      </Text>
      ) : null}

      {}
      {!compact && ledgerGroups.length > 1 ? (
        <Text wrap="truncate-end">
          <Text color={tok.textMuted}>ledger  </Text>
          {ledgerGroups.map(([label, g], i) => {
            const groupDone = g.done === g.total
            return (
              <Text key={label}>
                {i > 0 ? <Text color={tok.textMuted}> · </Text> : null}
                <Text bold={!groupDone} color={groupDone ? tok.success : TERRA}>
                  {groupDone ? GLYPH.done : GLYPH.inProgress}{' '}
                </Text>
                <Text color={groupDone ? tok.textMuted : tok.textPrimary}>{truncateToWidth(label, 18)}</Text>
                <Text color={tok.textMuted}>{` ${g.done}/${g.total}`}</Text>
              </Text>
            )
          })}
        </Text>
      ) : null}

      {}
      {!compact && ctx.window > 0 ? (
        <Text wrap="truncate-end">
          <Text color={tok.textMuted}>{'ctx '}</Text>
          {ctx.usedPct != null ? (
            <Text>
              <ProgressBar value={ctx.usedPct} max={100} width={5} showPct />
              <Text color={tok.textMuted}>{` · ${ctx.fillSource === 'estimate' ? '≈' : ''}${ctxUsedK}k/${ctxWinLabel}`}</Text>
            </Text>
          ) : (
            <Text>
              <ProgressBar value={0} max={100} width={5} tone={tok.textMuted} />
              <Text color={tok.textMuted}>{` · ${ctxWinLabel} window`}</Text>
            </Text>
          )}
          {ctxRule !== undefined ? <Text color={tok.textMuted}>{` · ${ctxRule}`}</Text> : null}
          {}
        </Text>
      ) : null}

      {}
      {compact ? null : opsRow}

    </Box>
  )
}
