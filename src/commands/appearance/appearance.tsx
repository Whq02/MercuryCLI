import * as React from 'react'
import { useState } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { CommandCenter } from '../../components/mercury-ui/components.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { useSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { ThemePicker } from '../../components/ThemePicker.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- 'm' (motion toggle) is center-specific and not in the keybinding schema
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { useSettings } from '../../hooks/useSettings.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import type { ThemeSetting } from '../../utils/theme.js'

type Props = {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

// The APPEARANCE CENTER: one place for how Mercury looks.
//  · THEME  — the canonical ThemePicker embedded unchanged (arrows preview
//             LIVE against the real chrome — the running app IS the specimen;
//             Enter applies + persists; Esc restores the prior theme exactly;
//             the OSC 11 ground re-syncs through the ThemeProvider effect).
//  · ACCENT — the live identity accent (critter pick · /accent override ·
//             scribe glow) with its real swatch and the deep links.
//  · MOTION — full ↔ reduced ('m' toggles; persists prefersReducedMotion,
//             which every decorative animation gate already honors with
//             frame-0 static degradation — progress semantics survive).
function AppearanceCenter({ onDone }: Props): React.ReactNode {
  const tokens = useMercuryTokens()
  const accent = useSessionAccent()
  // Synchronous acknowledgement: the settings file-watcher
  // refresh is async, so the toggled value shows IMMEDIATELY from the local
  // override while the persisted read catches up.
  const settingsReduced = useSettings().prefersReducedMotion ?? false
  const [motionOverride, setMotionOverride] = useState<boolean | null>(null)
  const reduced = motionOverride ?? settingsReduced
  const [motionNote, setMotionNote] = useState<string | null>(null)

  useInput(input => {
    if (input === 'm') {
      const next = !reduced
      const { error } = updateSettingsForSource('userSettings', {
        prefersReducedMotion: next,
      })
      if (!error) setMotionOverride(next)
      setMotionNote(
        error
          ? `not saved: ${error.message}`
          : next
            ? 'reduced — decorative animation off, state changes stay visible'
            : 'full — decorative animation on',
      )
    }
  })

  const close = (): void =>
    onDone('Appearance center dismissed', { display: 'system' })
  const applyTheme = (setting: ThemeSetting): void => {
    onDone(`Theme set to ${setting} — /appearance to revisit`)
  }

  return (
    <CommandCenter
      view="appearance"
      subtitle="theme · accent · motion"
      captureInput={false}
      onClose={close}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={tokens.textSecondary}>
            THEME
          </Text>
          <ThemePicker
            onThemeSelect={applyTheme}
            onCancel={close}
            skipExitHandling={true}
            hideEscToCancel={true}
            hideTitle={true}
          />
        </Box>
        <Box flexDirection="column">
          <Text bold color={tokens.textSecondary}>
            ACCENT
          </Text>
          <Text>
            {'  '}
            <Text color={accent.accent}>{'● '}</Text>
            <Text color={tokens.textPrimary}>{accent.accent}</Text>
            <Text color={tokens.textMuted}>
              {' — /critter picks the creature · /accent overrides (name, #hex, reset)'}
            </Text>
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text bold color={tokens.textSecondary}>
            MOTION
          </Text>
          <Text>
            {'  '}
            <Text color={tokens.textPrimary}>{reduced ? 'reduced' : 'full'}</Text>
            <Text color={tokens.textMuted}>
              {motionNote
                ? ` — ${motionNote}`
                : ' — m toggles · reduced keeps progress visible without decorative animation'}
            </Text>
          </Text>
        </Box>
      </Box>
    </CommandCenter>
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  return <AppearanceCenter onDone={onDone} />
}
