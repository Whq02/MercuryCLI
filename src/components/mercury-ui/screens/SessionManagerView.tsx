import type { UUID } from 'crypto'
import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { getSessionId } from '../../../bootstrap/state.js'
import type { ResumeEntrypoint } from '../../../commands.js'
import { Box, Text, useInput } from '../../../ink.js'
import type { LogOption } from '../../../types/logs.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { formatFileSize, formatRelativeTimeAgo } from '../../../utils/format.js'
import { retentionWindowDays } from '../../../utils/cleanup.js'
import {
  buildPruneOffer,
  operatorPruneTranscripts,
  type PruneOffer,
  type PruneReceipt,
} from '../../../utils/sessionStorage/transcriptPruneDoor.js'
import { boardHomedSessionIds } from '../../../daemon/concourseSupervisor.js'
import { getSessionIdFromLog } from '../../../utils/sessionStorage.js'
import { AMBER, CRIMSON, DUNE, FAINT, IVORY, SECOND, TEAL } from '../../mercuryPalette.js'
import { useSessionPickerModel, type SessionScope } from './sessionPickerModel.js'
import { useMercuryTokens } from '../useMercuryTokens.js'
import {
  CommandCenter,
  EmptyState,
  SectionHeader,
  StateBadge,
} from '../components.js'
import { padTo, truncateToWidth } from '../glyphs.js'
import { useSessionAccent } from '../sessionAccent.js'
import { critterForKey } from '../../../utils/cockpit/critterVariant.js'
import { Spinner } from '../../Spinner.js'
import { useOpenEventGate } from '../useOpenEventGate.js'
import { useInteractiveList } from '../useInteractiveList.js'
import { useStableSelection } from '../useStableSelection.js'
import { decodeNavKey } from '../navSemantics.js'
import { InteractiveRow } from '../InteractiveRow.js'

function shellInteriorWidth(columns: number): number {
  return Math.max(40, columns - 4)
}


export function SessionManagerView({
  onClose,
  onCloseAll,
  onResume,
  onNewSession,
  initialScope,
}: {
  onClose: () => void
  onCloseAll?: () => void
  onResume?: (
    sessionId: UUID,
    log: LogOption,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>
  onNewSession?: () => void
  initialScope?: SessionScope
}): React.ReactNode {
  if (onResume && onNewSession) {
    return (
      <LiveSessionManager
        onClose={onClose}
        onCloseAll={onCloseAll ?? onClose}
        onResume={onResume}
        onNewSession={onNewSession}
        initialScope={initialScope ?? 'project'}
      />
    )
  }
  return (
    <CommandCenter view="sessions" onClose={onClose} captureInput={false}>
      <Box marginTop={1}>
        <EmptyState
          title="Session switching needs the interactive REPL wiring"
          hint="run /sessions (project scope) or /resume (full history) from the prompt"
        />
      </Box>
    </CommandCenter>
  )
}

export type { SessionScope } from './sessionPickerModel.js'

export function computeSessionWindow(
  sel: number,
  total: number,
  size: number,
): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total }
  const clampedSel = Math.max(0, Math.min(sel, total - 1))
  const start = Math.max(0, Math.min(clampedSel - (size - 2), total - size))
  return { start, end: start + size }
}


function LiveSessionManager({
  onClose,
  onCloseAll,
  onResume,
  onNewSession,
  initialScope,
}: {
  onClose: () => void
  onCloseAll: () => void
  onResume: (
    sessionId: UUID,
    log: LogOption,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>
  onNewSession: () => void
  initialScope: SessionScope
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const accent = useSessionAccent().accent
  const { columns } = useTerminalSize()
  const W = shellInteriorWidth(columns)
  const [switching, setSwitching] = useState<'swapping' | null>(null)
  const switchGenRef = useRef(0)
  const [scope, setScope] = useState<SessionScope>(initialScope)
  const { logs, pendingMore, flat, crew, elsewhereCount, dropSessions } = useSessionPickerModel(scope)
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null)
  const [prune, setPrune] = useState<
    | { stage: 'card'; offer: PruneOffer; answer: 'no' | 'yes' }
    | { stage: 'deleting' }
    | { stage: 'receipt'; receipt: PruneReceipt }
    | null
  >(null)

  const pastOpenEvent = useOpenEventGate()

  const WINDOW = 8
  const CREW_CAP = 4
  const crewShown = crew.slice(0, CREW_CAP)
  const crewHidden = crew.length - crewShown.length
  const navKeys = useMemo(
    () => [
      ...flat.map(f => `s:${getSessionIdFromLog(f.row.log) ?? `${f.project}:${f.row.label}`}`),
      ...crewShown.map(c => `c:${c.tag}:${c.label}`),
    ],
    [flat, crewShown],
  )
  const stable = useStableSelection(navKeys, k => k)
  const sel = stable.index
  const navLen = flat.length + crewShown.length
  const confirmingResolved = confirmingKey === null ? -1 : navKeys.indexOf(confirmingKey)
  const confirming: number | null = confirmingResolved >= 0 ? confirmingResolved : null
  const { start: winStart, end: winEnd } = computeSessionWindow(sel, flat.length, WINDOW)
  const shown = flat.slice(winStart, winEnd)
  const newerHidden = winStart
  const olderHidden = flat.length - winEnd
  const targetAt = (i: number): LogOption | null =>
    i < flat.length ? (flat[i]?.row.log ?? null) : (crewShown[i - flat.length]?.log ?? null)
  const targetLabel = (i: number): string =>
    i < flat.length
      ? (flat[i]?.row.label ?? '')
      : `${crewShown[i - flat.length]?.tag ?? ''} — ${crewShown[i - flat.length]?.label ?? ''}`
  const moveTo = (i: number): void => {
    stable.select(Math.max(0, Math.min(i, Math.max(0, navLen - 1))))
    setConfirmingKey(null)
  }

  const openPruneDoor = (): void => {
    const offer = buildPruneOffer(
      flat.map(f => f.row.log),
      {
        scopeLabel:
          scope === 'project'
            ? "this project's listed chats"
            : 'the full history (every project, cleared included)',
        windowDays: retentionWindowDays(),
        activeSessionId: String(getSessionId() ?? ''),
        liveSessionIds: boardHomedSessionIds(),
      },
    )
    setPrune({ stage: 'card', offer, answer: 'no' })
  }

  async function runPrune(offer: PruneOffer) {
    setPrune({ stage: 'deleting' })
    const receipt = await operatorPruneTranscripts(offer)
    dropSessions(new Set(receipt.deletedSessionIds))
    setPrune({ stage: 'receipt', receipt })
  }

  async function switchTo(i: number) {
    const log = targetAt(i)
    if (!log) return
    const sessionId = getSessionIdFromLog(log)
    if (!sessionId) return
    const gen = ++switchGenRef.current
    setSwitching('swapping')
    try {
      await onResume(sessionId, log, 'slash_command_picker')
      if (gen !== switchGenRef.current) return
      onCloseAll()
    } catch {
      if (gen === switchGenRef.current) setSwitching(null)
    }
  }

  const leaveSwitch = (): void => {
    const phase = switching
    switchGenRef.current++
    setSwitching(null)
    setConfirmingKey(null)
    if (phase === 'swapping') onCloseAll()
  }

  useInput(
    (input, key) => {
      if (switching !== null) {
        if (key.escape) leaveSwitch()
        return
      }
      if (prune !== null) {
        if (prune.stage === 'deleting') return
        if (prune.stage === 'receipt') {
          if (key.return || key.escape) setPrune(null)
          return
        }
        if (key.escape || input === 'n') {
          setPrune(null)
          return
        }
        if (key.upArrow || key.downArrow) {
          const offered = prune.offer.candidates.length > 0
          setPrune({
            ...prune,
            answer: offered && prune.answer === 'no' ? 'yes' : 'no',
          })
          return
        }
        if (!pastOpenEvent()) return
        if (key.return) {
          if (prune.answer === 'yes' && prune.offer.candidates.length > 0) {
            void runPrune(prune.offer)
          } else {
            setPrune(null)
          }
          return
        }
        return
      }
      if (confirming !== null) {
        if (key.escape || input === 'n') {
          setConfirmingKey(null)
          return
        }
        if (!pastOpenEvent()) return
        if (key.return) {
          void switchTo(confirming)
          return
        }
        return
      }
      const action = decodeNavKey(input, key, { orientation: 'vertical', leftCloses: true })
      if (action === 'cancel') {
        onClose()
        return
      }
      if (action === 'movePrevious') {
        moveTo(sel - 1)
        return
      }
      if (action === 'moveNext') {
        moveTo(sel + 1)
        return
      }
      if (action === 'first') {
        moveTo(0)
        return
      }
      if (action === 'last') {
        moveTo(navLen - 1)
        return
      }
      if (!pastOpenEvent()) return
      if (key.return && navLen > 0) {
        setConfirmingKey(navKeys[Math.min(sel, navLen - 1)] ?? null)
        return
      }
      if (input === 'n') {
        onNewSession()
        return
      }
      if (input === 'a') {
        setScope(s => (s === 'project' ? 'all' : 'project'))
        stable.select(0)
        setConfirmingKey(null)
        return
      }
      if (input === 'd' && !key.ctrl && !key.meta) {
        openPruneDoor()
        return
      }
    },
    { isActive: true },
  )

  const scopeHint = scope === 'project' ? 'a all history' : 'a this project'
  const footer =
    confirming !== null
      ? '↵ yes, switch · esc / n cancel'
      : navLen > 0
        ? `↑↓ / click browse · ↵ switch · n new · d prune · ${scopeHint} · esc / ← close`
        : `n new · d prune · ${scopeHint} · esc / ← close`

  if (switching !== null) {
    return (
      <CommandCenter
        view="sessions"
        onClose={leaveSwitch}
        captureInput={false}
        footer="switching — the swap keeps going · esc back to the chat"
      >
        <Box marginTop={1}>
          <Spinner />
          <Text color={SECOND}> Switching session…</Text>
        </Box>
      </CommandCenter>
    )
  }

  if (prune !== null) {
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

  return (
    <CommandCenter
      view="sessions"
      onClose={onClose}
      captureInput={false}
      footer={footer}
    >
      {}
      <Box marginTop={1}>
        <Text wrap="truncate">
          <Text color={accent}>▣ </Text>
          <Text bold color={IVORY}>this session</Text>
          <Text color={TEAL}> ● active</Text>
          <Text color={FAINT}> · browsing never closes it · switching pauses the current, state kept</Text>
        </Text>
      </Box>

      <SectionHeader count={flat.length}>
        {`${scope === 'project' ? 'Switch to' : 'Full history — every project, cleared included'}${pendingMore > 0 ? ` · loading ${pendingMore} more…` : ''}`}
      </SectionHeader>
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
              : crewShown.length > 0
                ? 'n starts a fresh session in-place · ↑↓ reaches the router-crew transcripts below'
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
              const def = critterForKey(getSessionIdFromLog(f.row.log) ?? f.row.label)
              const cardKey = navKeys[i] ?? (getSessionIdFromLog(f.row.log) ?? f.row.label)
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
                  {
}
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
      {
}
      {scope === 'project' && flat.length > 0 && elsewhereCount > 0 ? (
        <Text color={FAINT}>  +{elsewhereCount} in other projects — a shows all history</Text>
      ) : null}

      {
}
      {crewShown.length > 0 ? (
        <>
          <SectionHeader count={crew.length}>Router crews</SectionHeader>
          {crewShown.map((c, ci) => {
            const i = flat.length + ci
            const on = i === sel
            const crewKey = navKeys[i] ?? `crew-${ci}`
            return (
              <InteractiveRow
                key={crewKey}
                id={`sessions-live:crew:${crewKey}`}
                selected={on}
                onSelect={() => moveTo(i)}
                onActivate={() => setConfirmingKey(navKeys[i] ?? null)}
              >
              {hover => (
              <Box backgroundColor={on ? tokens.selectionBand : hover ? tokens.surface2 : undefined}>
                <Text wrap="truncate-end">
                  <Text color={on ? tokens.success : tokens.textMuted}>{on ? ' ▸ ' : '   '}</Text>
                  <Text color={on ? tokens.textPrimary : tokens.textSecondary}>{padTo(c.tag, 22)}</Text>
                  <Text color={tokens.textMuted}>{truncateToWidth(c.label, 34)}</Text>
                  <Text color={tokens.textMuted}> · {c.seen}</Text>
                </Text>
              </Box>
              )}
              </InteractiveRow>
            )
          })}
          {crewHidden > 0 ? (
            <Text color={FAINT}>  +{crewHidden} more crew transcripts (newest {CREW_CAP} shown)</Text>
          ) : null}
        </>
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
      )}
    </CommandCenter>
  )
}
