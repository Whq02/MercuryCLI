import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from './mercuryPalette.js'
import { CommandCenter, EmptyState, SectionHeader, StateBadge } from './mercury-ui/components.js'
import { GLYPH, truncateToWidth } from './mercury-ui/glyphs.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useFlatList } from './mercury-ui/useFlatList.js'
import {
  listExperienceCards,
  promoteExperienceCard,
  type ExperienceCardListing,
} from '../memdir/experienceCards.js'
import { getAutoMemPath } from '../memdir/paths.js'

// ============================================================================
//  CardsView — the /cards experience-card browser + promoter.
//
//  Lists Mercury's experience-card memory (candidate→approved) from the auto-
//  memory dir: candidates are unverified hypotheses the agent banked (via
//  RememberLesson / /remember); approved are operator-trusted lessons. This closes
//  the OTHER half of the severed loop — promoteExperienceCard (the proven,
//  gate-guarded candidate→approved path) had ZERO runtime callers, so a candidate
//  could be written + recalled but NEVER promoted in-session. ↵ (or `p`)
//  promotes the selected candidate.
//
//  Read-derived (mirror, not fork): the ONLY write is an explicit operator promote;
//  it never deletes or edits a card otherwise. State + input live in the shared
//  mercury-ui useFlatList engine (STALE-PAINT discipline, ↵-primary grammar,
//  error ≠ empty). Honest-empty when there are no cards; an UNREADABLE memory
//  dir says so instead of impersonating emptiness. The command is fork+card
//  gated ⇒ OFF ⇒ absent ⇒ byte-identical.
// ============================================================================

const MAX_ROWS = 16

// A transient status line under the list. Its colour reads off the design
// system's status taxonomy (components.tsx CHIP_TONE), NOT a string-sniff: a
// hard promote failure is CRIMSON ('danger'/'failed' — distinct from, and no
// longer colliding with, the AMBER 'warn' the candidate row owns), a no-op /
// already-approved is muted SECOND, an in-flight promote is FAINT 'pending',
// and only a real flip is TEAL success.
const NOTE_COLOR: Record<'ok' | 'warn' | 'fail' | 'pending', string> = {
  ok: TEAL,
  warn: SECOND,
  fail: CRIMSON,
  pending: FAINT,
}

export function CardsView({ onClose }: { onClose: () => void }): React.ReactNode {
  const accent = useSessionAccent().accent

  function promote(card: ExperienceCardListing): void {
    if (fl.busyRef.current) return
    if (card.meta.approved) {
      // a no-op (already a trusted lesson) — neither a success nor a failure.
      fl.setNote({ text: `${card.name} is already approved`, kind: 'warn' })
      return
    }
    fl.busyRef.current = true
    fl.setNote({ text: `promoting ${card.name} …`, kind: 'pending' })
    promoteExperienceCard(getAutoMemPath(), card.name)
      .then(res => {
        if (res.ok) {
          fl.setNote(
            res.alreadyApproved
              ? { text: `${card.name} already approved`, kind: 'warn' }
              : { text: `${GLYPH.check} promoted ${card.name} → approved`, kind: 'ok' },
          )
        } else {
          // a hard failure — gate-blocked or not-found. CRIMSON ('failed'), not
          // the AMBER 'warn' hue the candidate row owns.
          fl.setNote({ text: `${GLYPH.fail} ${res.blocked}: ${res.reason}`, kind: 'fail' })
        }
        fl.reload() // re-read so the flip shows
      })
      .catch((e: unknown) =>
        fl.setNote({ text: `${GLYPH.fail} promote failed: ${String(e)}`, kind: 'fail' }),
      )
      .finally(() => {
        fl.busyRef.current = false
      })
  }

  const fl = useFlatList<ExperienceCardListing>({
    load: () => listExperienceCards(getAutoMemPath()),
    maxRows: MAX_ROWS,
    onClose,
    onPrimary: promote,
    primaryChar: 'p',
    reloadNote: 're-read memory dir',
    rowId: c => c.name,
  })

  const { list, visible, above, below, clampedSel, selected, note, loadError } = fl
  const candidates = list.filter(c => !c.meta.approved).length
  const approved = list.length - candidates

  const footer = loadError
    ? 'r retry'
    : list.length > 0
      ? '↑↓ move · ↵/p promote · r re-read'
      : 'r re-read'

  return (
    <CommandCenter
      view="cards"
      subtitle="experience-card memory"
      onClose={onClose}
      captureInput={false}
      footer={footer}
    >
      {fl.raw === null ? (
        <Box marginTop={1}>
          <Text color={FAINT}>◓ reading memory dir …</Text>
        </Box>
      ) : loadError ? (
        // error ≠ empty: an unreadable store must never render as "no cards".
        <Box marginTop={1} flexDirection="column">
          <Text color={AMBER}>{`▲ memory unreadable — ${truncateToWidth(loadError, 58)}`}</Text>
          <Text color={FAINT}>the card list is unknown, not empty · r retries the read</Text>
        </Box>
      ) : list.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          <EmptyState
            glyph="○"
            title="no experience cards yet"
            hint="the agent banks lessons (RememberLesson / /remember); they land here as candidates to promote"
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box marginTop={1}>
            <StateBadge state="gated" label={`${candidates} candidate${candidates === 1 ? '' : 's'}`} />
            <Text color={FAINT}> · </Text>
            <StateBadge state="live" label={`${approved} approved`} />
          </Box>

          <SectionHeader count={list.length}>Cards</SectionHeader>
          {above > 0 ? <Text color={FAINT}>{`  +${above} above`}</Text> : null}
          {visible.map((c, i) => {
            const active = i === clampedSel
            return (
              <Text key={c.name}>
                <Text color={active ? accent : FAINT}>{active ? '▸ ' : '  '}</Text>
                <Text color={c.meta.approved ? TEAL : AMBER}>{c.meta.approved ? '● ' : '○ '}</Text>
                <Text color={IVORY}>{truncateToWidth(c.title, 42)}</Text>
                <Text color={FAINT}>{`  ${c.meta.problemClass}`}</Text>
              </Text>
            )
          })}
          {below > 0 ? <Text color={FAINT}>{`  +${below} more below`}</Text> : null}

          {/* selected detail — the trust signals the promote gate weighs */}
          {selected ? (
            <Box marginTop={1}>
              <Text color={FAINT}>
                {'  '}
                {selected.meta.approved ? 'approved' : 'candidate'} · {selected.meta.confidence} ·{' '}
                {selected.meta.freshness} · {selected.meta.scope}
              </Text>
            </Box>
          ) : null}

          {note ? (
            <Box marginTop={1}>
              <Text color={NOTE_COLOR[note.kind]}>{truncateToWidth(note.text, 64)}</Text>
            </Box>
          ) : null}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={FAINT}>candidates are unverified hypotheses · ↵ promotes the selected one to a trusted lesson</Text>
      </Box>
    </CommandCenter>
  )
}
