import * as React from 'react'
import { Box, Text } from '../ink.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from './mercuryPalette.js'
import { CommandCenter, EmptyState, SectionHeader } from './mercury-ui/components.js'
import { GLYPH, truncateToWidth } from './mercury-ui/glyphs.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useFlatList } from './mercury-ui/useFlatList.js'
import {
  listScribeCandidates,
  promoteScribeCandidate,
  type ScribeCandidateListing,
} from '../memdir/scribePromote.js'

// ============================================================================
//  ScribeCandidatesView — the /scribe-promote browser + ratifier.
//
//  Closes the severed RATIFY half of the scribe-note loop. Scribe Mode stages
//  COMPACT session notes into the recall-excluded `scribe/` scope (via the
//  RememberLesson `scope:'scribe'` route); promoteScribeCandidate (the proven,
//  non-clobbering, secret-refusing ratify path that moves a candidate into root
//  memory + indexes it + flips approved:false→true) had ZERO runtime callers, so
//  a staged note could never be ratified in-session. ↵ (or `p`) ratifies the
//  selected candidate — exactly mirroring how /cards (CardsView) closed the
//  experience-card promote loop.
//
//  Read-derived (mirror, not fork): the ONLY write is an explicit operator
//  ratify. State + input live in the shared mercury-ui useFlatList engine
//  (STALE-PAINT discipline, ↵-primary grammar, error ≠ empty). Honest-empty
//  when there are no candidates; an unreadable scribe scope says so. Fork+
//  scribe gated ⇒ OFF ⇒ absent.
// ============================================================================

const MAX_ROWS = 16

const NOTE_COLOR: Record<'ok' | 'warn' | 'fail' | 'pending', string> = {
  ok: TEAL,
  warn: SECOND,
  fail: CRIMSON,
  pending: FAINT,
}

// promoteScribeCandidate's structured refusal reasons → an honest operator line.
const REFUSAL: Record<string, string> = {
  'not-found': 'candidate not found (already ratified?)',
  'target-exists': 'a memory of that name already exists — rename or remove it first',
  'secret-bearing': 'refused — the candidate now carries a secret (edit it out, then retry)',
}

export function ScribeCandidatesView({ onClose }: { onClose: () => void }): React.ReactNode {
  const accent = useSessionAccent().accent

  function ratify(cand: ScribeCandidateListing): void {
    if (fl.busyRef.current) return
    fl.busyRef.current = true
    fl.setNote({ text: `ratifying ${cand.name} → root memory …`, kind: 'pending' })
    promoteScribeCandidate(cand.file, 'private')
      .then(res => {
        if (res.ok) {
          fl.setNote({ text: `${GLYPH.check} ratified ${cand.name} → root memory`, kind: 'ok' })
        } else {
          fl.setNote({ text: `${GLYPH.fail} ${REFUSAL[res.reason] ?? res.reason}`, kind: 'fail' })
        }
        fl.reload() // re-read so the ratified note drops out of the list
      })
      .catch((e: unknown) =>
        fl.setNote({ text: `${GLYPH.fail} ratify failed: ${String(e)}`, kind: 'fail' }),
      )
      .finally(() => {
        fl.busyRef.current = false
      })
  }

  const fl = useFlatList<ScribeCandidateListing>({
    load: () => listScribeCandidates(),
    maxRows: MAX_ROWS,
    onClose,
    onPrimary: ratify,
    primaryChar: 'p',
    reloadNote: 're-read scribe scope',
    rowId: c => c.file,
  })

  const { list, visible, above, below, clampedSel, selected, note, loadError } = fl

  const footer = loadError
    ? 'r retry'
    : list.length > 0
      ? '↑↓ move · ↵/p ratify · r re-read'
      : 'r re-read'

  return (
    <CommandCenter
      view="scribe-promote"
      subtitle="staged scribe candidates"
      onClose={onClose}
      captureInput={false}
      footer={footer}
    >
      {fl.raw === null ? (
        <Box marginTop={1}>
          <Text color={FAINT}>◓ reading scribe scope …</Text>
        </Box>
      ) : loadError ? (
        // error ≠ empty: an unreadable scope must never render as "no candidates".
        <Box marginTop={1} flexDirection="column">
          <Text color={AMBER}>{`▲ scribe scope unreadable — ${truncateToWidth(loadError, 54)}`}</Text>
          <Text color={FAINT}>the candidate list is unknown, not empty · r retries the read</Text>
        </Box>
      ) : list.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          <EmptyState
            glyph="○"
            title="no staged scribe candidates"
            hint="Scribe Mode stages compact session notes here (recall-excluded); ratify the selected one with ↵"
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          <SectionHeader count={list.length}>Candidates</SectionHeader>
          {above > 0 ? <Text color={FAINT}>{`  +${above} above`}</Text> : null}
          {visible.map((c, i) => {
            const active = i === clampedSel
            return (
              <Text key={c.file}>
                <Text color={active ? accent : FAINT}>{active ? '▸ ' : '  '}</Text>
                <Text color={SECOND}>{'○ '}</Text>
                <Text color={IVORY}>{truncateToWidth(c.title, 56)}</Text>
              </Text>
            )
          })}
          {below > 0 ? <Text color={FAINT}>{`  +${below} more below`}</Text> : null}

          {selected ? (
            <Box marginTop={1}>
              <Text color={FAINT}>{`  ${truncateToWidth(selected.description, 64)}`}</Text>
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
        <Text color={FAINT}>scribe candidates are recall-excluded until ratified · ↵ moves the selected one into root memory</Text>
      </Box>
    </CommandCenter>
  )
}
