import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { FAINT, IVORY, SECOND } from './mercuryPalette.js'
import { CommandCenter, SectionHeader, StateBadge } from './mercury-ui/components.js'
import { GLYPH, displayWidth, truncateToWidth } from './mercury-ui/glyphs.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'

// ============================================================================
//  MercuryLanguagePicker — the warm-ink response-language entry surface. Not a
//  list (free text), so it's a single hardened text field: ONE useInput owns the
//  query buffer (typed chars append, backspace deletes), ↵ submits the trimmed
//  value (empty → default English), esc cancels. isActive-gated so it never
//  fights the REPL, 150ms enter-buffer so the launching keystroke can't submit
//  the seeded value. The echoed input is truncated to the field width so a long
//  paste never wraps and breaks the panel. No live data — config-only.
// ============================================================================

const FIELD_WIDTH = 60
// A short curated set of common choices, shown as honest illustrative hints
// (typing is free-form — these are not a closed list).
const SUGGESTIONS = ['English', 'Español', '日本語', 'Français', 'Deutsch', '中文']

export function MercuryLanguagePicker({
  initialLanguage,
  onComplete,
  onCancel,
  isActive = true,
}: {
  initialLanguage?: string
  onComplete: (language: string | undefined) => void
  onCancel: () => void
  isActive?: boolean
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const [value, setValue] = useState(initialLanguage ?? '')

  // 150ms buffer so the keystroke that launched /config doesn't immediately
  // submit — as a open-event seq gate (event identity, not wall-clock), not the old setTimeout→setState
  // flag whose parked commit swallowed the first ↵ nondeterministically
  // esc
  // responds instantly; ↵/backspace/typing wait out the buffer (no arrows on
  // this free-text field).
  const pastOpenEvent = useOpenEventGate()

  useInput(
    (input, key) => {
      if (!isActive) return
      if (key.escape) {
        onCancel()
        return
      }
      if (!pastOpenEvent()) return
      if (key.return) {
        const trimmed = value.trim()
        onComplete(trimmed || undefined)
        return
      }
      if (key.backspace || key.delete) {
        setValue(v => [...v].slice(0, -1).join(''))
        return
      }
      // Ignore control chords / nav keys; only printable runs append.
      if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        setValue(v => v + input)
      }
    },
    { isActive },
  )

  const shown = truncateToWidth(value, FIELD_WIDTH)
  const empty = value.length === 0

  return (
    <CommandCenter view="language" onClose={onCancel} captureInput={false} footer="type · ↵ save · esc cancel">
      <Box marginTop={1} flexDirection="column">
        <Text>
          <StateBadge state="live" label="response language" />
        </Text>
        <Text color={SECOND}>Enter your preferred response language.</Text>
      </Box>

      <SectionHeader>Language</SectionHeader>
      <Text>
        <Text color={accent}>{GLYPH.prompt} </Text>
        {empty ? (
          <Text color={FAINT}>e.g., Japanese, 日本語, Español…</Text>
        ) : (
          <Text color={IVORY}>
            {shown}
            <Text color={accent}>{displayWidth(value) <= FIELD_WIDTH ? '▎' : ''}</Text>
          </Text>
        )}
      </Text>
      <Text color={FAINT}>Leave empty for default (English).</Text>

      <SectionHeader>Common choices</SectionHeader>
      <Text color={SECOND}>{SUGGESTIONS.join('  ·  ')}</Text>
    </CommandCenter>
  )
}
