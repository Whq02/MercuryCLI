import * as React from 'react'
import { Box, Text } from '../../../themedRenderer.js'
import type { SessionListing } from '../../../../sessions/transcripts/transcriptEntries.js'
import { formatFileSize, formatRelativeTimeAgo } from '../../../../platform/text/format.js'
import type { PruneOffer, PruneReceipt } from '../../../../daemon/switchboard/transcriptPruneDoor.js'
import { sessionIdOfListing } from '../../../../sessions/transcripts/sessionStorage.js'
import { AMBER, CRIMSON, DUNE, FAINT, IVORY, SECOND, TEAL } from '../../../theme/mercuryPalette.js'
import type { useSessionPickerModel, SessionScope } from '../sessionPickerModel.js'
import { CommandCenter, EmptyState, SectionHeader } from '../../components.js'
import { truncateToWidth } from '../../../theme/glyphs.js'
import { critterForKey } from '../../../cockpit/critterVariant.js'
import { Spinner } from '../../../spinner/Spinner.js'
import { InteractiveRow } from '../../InteractiveRow.js'
import type { MercuryThemeTokens } from '../../../theme/mercuryTokens.js'

export interface OwnSessionStateWords {
  glyph: string
  state: string
  tail: string
  parked: boolean
}

type PruneStage = { stage: 'card'; offer: PruneOffer; answer: 'no' | 'yes' } | { stage: 'deleting' } | { stage: 'receipt'; receipt: PruneReceipt }

export function prunePaneOf({
  prune,
  setPrune,
  accent,
}: {
  prune: PruneStage
  setPrune: React.Dispatch<React.SetStateAction<PruneStage | null>>
  accent: string
}): React.ReactNode {
  const pruneFooter =
    prune.stage === 'card'
      ? prune.offer.candidates.length > 0
        ? '↑↓ choose · ↵ commit (No is the default) · esc / n keep everything'
        : '↵ / esc close'
      : prune.stage === 'receipt'
        ? '↵ / esc back to the list'
        : 'deleting the named set…'
  return (
    <CommandCenter
      view="sessions"
      onClose={() => setPrune(null)}
      captureInput={false}
      closeKeys={prune.stage === 'deleting' ? 'none' : 'esc-arrow'}
      footer={pruneFooter}
    >
      {prune.stage === 'card' ? (
        <Box marginTop={1} flexDirection="column">
          <Text wrap="truncate">
            <Text bold color={AMBER}>prune transcripts</Text>
            <Text color={FAINT}> · the one deleting door — nothing is ever deleted automatically</Text>
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text wrap="truncate" color={SECOND}>
              scope: <Text color={IVORY}>{prune.offer.scopeLabel}</Text> older than{' '}
              <Text color={IVORY}>{prune.offer.windowDays} days</Text>
            </Text>
            {prune.offer.candidates.length > 0 ? (
              <>
                <Text wrap="truncate" color={SECOND}>
                  would delete:{' '}
                  <Text color={IVORY}>
                    {prune.offer.candidates.length} transcript
                    {prune.offer.candidates.length === 1 ? '' : 's'}
                  </Text>
                  {' '}· total <Text color={IVORY}>{formatFileSize(prune.offer.totalBytes)}</Text>
                </Text>
                <Text wrap="truncate" color={SECOND}>
                  age range:{' '}
                  <Text color={IVORY}>
                    {prune.offer.oldestModified
                      ? formatRelativeTimeAgo(prune.offer.oldestModified, { style: 'short' })
                      : '—'}
                    {' → '}
                    {prune.offer.newestModified
                      ? formatRelativeTimeAgo(prune.offer.newestModified, { style: 'short' })
                      : '—'}
                  </Text>
                </Text>
              </>
            ) : (
              <Text wrap="truncate" color={FAINT}>
                nothing to prune — no listed chat is older than {prune.offer.windowDays} days
              </Text>
            )}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text color={prune.answer === 'no' ? accent : FAINT}>
                {prune.answer === 'no' ? '▸ ' : '  '}
              </Text>
              <Text bold={prune.answer === 'no'} color={prune.answer === 'no' ? IVORY : SECOND}>
                No — keep everything
              </Text>
              <Text color={FAINT}> (default)</Text>
            </Text>
            {prune.offer.candidates.length > 0 ? (
              <Text>
                <Text color={prune.answer === 'yes' ? accent : FAINT}>
                  {prune.answer === 'yes' ? '▸ ' : '  '}
                </Text>
                <Text bold={prune.answer === 'yes'} color={prune.answer === 'yes' ? CRIMSON : SECOND}>
                  Yes — delete exactly this set, for good
                </Text>
              </Text>
            ) : null}
          </Box>
          <Box marginTop={1}>
            <Text wrap="truncate" color={FAINT}>
              deletes exactly the set named above · asked every time, never remembered
            </Text>
          </Box>
        </Box>
      ) : prune.stage === 'deleting' ? (
        <Box marginTop={1}>
          <Spinner />
          <Text color={SECOND}> Deleting the named set…</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text wrap="truncate">
            <Text bold color={TEAL}>pruned</Text>
            <Text color={FAINT}> · the operator's own act</Text>
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text wrap="truncate" color={SECOND}>
              deleted{' '}
              <Text color={IVORY}>
                {prune.receipt.deleted} transcript{prune.receipt.deleted === 1 ? '' : 's'}
              </Text>
              {' '}· freed <Text color={IVORY}>{formatFileSize(prune.receipt.bytesFreed)}</Text>
              {' '}· <Text color={IVORY}>{formatRelativeTimeAgo(prune.receipt.at, { style: 'short' })}</Text>
              {' '}· by the operator
            </Text>
            {prune.receipt.failed > 0 ? (
              <Text wrap="truncate" color={AMBER}>
                {prune.receipt.failed} could not be deleted — still listed
              </Text>
            ) : null}
          </Box>
        </Box>
      )}
    </CommandCenter>
  )
}

export function sessionListView({
  onClose,
  footer,
  accent,
  ownState,
  flat,
  scope,
  pendingMore,
  logs,
  elsewhereCount,
  newerHidden,
  shown,
  winStart,
  sel,
  confirming,
  navKeys,
  moveTo,
  setConfirmingKey,
  tokens,
  olderHidden,
  targetAt,
  targetLabel,
  W,
  readNotice,
}: {
  onClose: () => void
  footer: string
  accent: string
  ownState: OwnSessionStateWords
  flat: ReturnType<typeof useSessionPickerModel>['flat']
  scope: SessionScope
  pendingMore: number
  logs: ReturnType<typeof useSessionPickerModel>['logs']
  elsewhereCount: number
  newerHidden: number
  shown: ReturnType<typeof useSessionPickerModel>['flat']
  winStart: number
  sel: number
  confirming: number | null
  navKeys: string[]
  moveTo: (i: number) => void
  setConfirmingKey: React.Dispatch<React.SetStateAction<string | null>>
  tokens: MercuryThemeTokens
  olderHidden: number
  targetAt: (i: number) => SessionListing | null
  targetLabel: (i: number) => string
  W: number
  readNotice?: string | null
}): React.ReactNode {
  return (
    <CommandCenter view="sessions"
      onClose={onClose}
      captureInput={false} footer={footer} bodyOwnsPageKeys ><Box marginTop={1}>
        <Text wrap="truncate">
          <Text color={accent}>▣ </Text>
          <Text bold color={IVORY}>this session</Text>
          <Text color={ownState.parked ? AMBER : TEAL}> {ownState.glyph} {ownState.state}</Text>
          <Text color={FAINT}>{ownState.tail}</Text>
        </Text>
      </Box>

      <SectionHeader count={flat.length}>
        {`${scope === 'project' ? 'Switch to' : 'Full history — every project, cleared included'}${pendingMore > 0 ? ` · loading ${pendingMore} more…` : ''}`}
      </SectionHeader>
      {readNotice ? (
        <Box>
          <Text color={AMBER} wrap="wrap">{readNotice}</Text>
        </Box>
      ) : null}
      {logs === null || (flat.length === 0 && pendingMore > 0) ? (
        <Box>
          <Spinner />
          <Text color={SECOND}> Loading sessions…</Text>
        </Box>
      ) : flat.length === 0 ? (
        <EmptyState
          tone="idle"
          glyph="⦿"
          title={
            scope === 'project'
              ? 'No other sessions in this project'
              : 'No other sessions anywhere'
          }
          hint={
            scope === 'project' && elsewhereCount > 0
              ? `n starts a fresh session in-place · ${elsewhereCount} in other projects — a shows them`
              : 'n starts a fresh session in-place · this is the only open session'
          }
        />
      ) : (
        <>
          {newerHidden > 0 ? (
            <Text color={FAINT}>  ↑ +{newerHidden} newer — ↑ scrolls</Text>
          ) : null}
          <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
            {shown.map((f, wi) => {
              const i = winStart + wi
              const on = i === sel
              const pending = confirming === i
              const def = critterForKey(sessionIdOfListing(f.row.log) ?? f.row.label)
              const cardKey = navKeys[i] ?? (sessionIdOfListing(f.row.log) ?? f.row.label)
              return (
                <InteractiveRow
                  key={cardKey}
                  id={`sessions-live:card:${cardKey}`}
                  selected={on}
                  onSelect={() => moveTo(i)}
                  onActivate={() => setConfirmingKey(navKeys[i] ?? null)}
                  flexDirection="column"
                  flexShrink={0}
                >
                {hover => (
                <Box
                  borderStyle="round"
                  borderColor={pending ? AMBER : on ? def.hue : DUNE}
                  backgroundColor={hover ? tokens.surface2 : undefined}
                  paddingX={1}
                  marginRight={1}
                  marginBottom={1}
                  width={26}
                  flexDirection="column"
                >
                  <Text>
                    <Text bold color={def.hue}>{truncateToWidth(f.project, 15)}</Text>
                    {on ? <Text color={TEAL}> ▸</Text> : null}
                  </Text>
                  <Text color={on ? IVORY : SECOND}>{truncateToWidth(f.row.label, 22)}</Text>
                  {}
                  <Text color={FAINT}>
                    {truncateToWidth(
                      f.row.cleared ? `${f.row.seen} · cleared` : f.row.seen,
                      22,
                    )}
                  </Text>
                  {pending ? <Text color={AMBER}>are you sure? ↵ yes</Text> : null}
                </Box>
                )}
                </InteractiveRow>
              )
            })}
          </Box>
        </>
      )}
      {olderHidden > 0 ? (
        <Text color={FAINT}>  ↓ +{olderHidden} older — ↓ scrolls</Text>
      ) : null}
      {}
      {scope === 'project' && flat.length > 0 && elsewhereCount > 0 ? (
        <Text color={FAINT}>  +{elsewhereCount} in other projects — a shows all history</Text>
      ) : null}

      {}
      {confirming !== null && targetAt(confirming) ? (
        <Box marginTop={1}>
          <Text bold color={AMBER}>are you sure? </Text>
          <Text color={SECOND}>
            {truncateToWidth(`switch to "${targetLabel(confirming)}" — this session pauses (state preserved). ↵ yes · esc cancel`, W - 16)}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={FAINT}>
            {truncateToWidth(
              '↵ arms a confirm, then swaps in-place — both sessions keep their state; switch back any time',
              W - 2,
            )}
          </Text>
        </Box>
      )}</CommandCenter>
  )
}
