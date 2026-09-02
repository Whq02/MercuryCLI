import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { FAINT, IVORY, SECOND } from './mercuryPalette.js'
import { CommandCenter, SectionHeader, StateBadge } from './mercury-ui/components.js'
import { GLYPH, displayWidth, truncateToWidth } from './mercury-ui/glyphs.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'


const FIELD_WIDTH = 60
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
