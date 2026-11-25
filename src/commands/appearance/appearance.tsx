import * as React from 'react'
import { useState } from 'react'
import type { CommandResultDisplay } from '../catalogue/commands.js'
import { LOCAL_COMMAND_STDOUT_TAG } from '../../engine/message-shapes/messageTags.js'
import { AMBER, CRIMSON, OASIS, TEAL, TERRA } from '../../screen/theme/mercuryPalette.js'
import { CommandCenter } from '../../screen/widgets/components.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { CRITTERS, getSessionAccent, getSessionAccentOverride, setSessionAccentOverride, useSessionAccent } from '../../screen/widgets/sessionAccent.js'
import { ThemePicker } from './ThemePicker.js'
import { Box, Text, useInput } from '../../screen/themedRenderer.js'
import type { LocalJSXCommandCall } from '../catalogue/command.js'
import { useSettings } from '../../screen/settings/useSettings.js'
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { createCommandInputMessage, createUserMessage, formatCommandInputTags } from '../../engine/messages/messages.js'
import { updateSettingsForSource } from '../../platform/settings/settings.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { themeLabel, type ThemeSetting } from '../../screen/theme/theme.js'

type Props = {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

function AppearanceCenter({ onDone }: Props): React.ReactNode {
  const tokens = useMercuryTokens()
  const accent = useSessionAccent()
  const settingsReduced = useSettings().view?.reducedMotion ?? false
  const [motionOverride, setMotionOverride] = useState<boolean | null>(null)
  const reduced = motionOverride ?? settingsReduced
  const [motionNote, setMotionNote] = useState<string | null>(null)

  useInput(input => {
    if (input === 'm') {
      const next = !reduced
      const { error } = updateSettingsForSource('userSettings', { view: { reducedMotion: next } })
      if (!error) setMotionOverride(next)
      if (error) logForDebugging(`appearance: reducedMotion could not be saved: ${error.message}`, { level: 'error' })
      setMotionNote(
        error
          ? 'appearance change could not be saved — try again'
          : next
            ? 'decorative animation off, state changes stay visible; saved for later boots'
            : 'decorative animation on; saved for later boots',
      )
    }
  })

  const close = (): void =>
    onDone('Appearance center dismissed', { display: 'system' })
  const applyTheme = (setting: ThemeSetting): void => {
    onDone(`Theme set to ${themeLabel(setting)} — saved for later boots; /appearance to revisit`)
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
              {' — /critter picks the creature · /appearance accent overrides (name, #hex, reset)'}
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

const ACCENT_NAMED: Record<string, string> = {
  terra: TERRA,
  teal: TEAL,
  amber: AMBER,
  oasis: OASIS,
  crimson: CRIMSON,
  crab: CRITTERS.crab!.accent,
  octopus: CRITTERS.octopus!.accent,
  jellyfish: CRITTERS.jellyfish!.accent,
  clam: CRITTERS.clam!.accent,
}

function accentReceipt(rawArg: string): string {
  const arg = rawArg.trim().toLowerCase()
  if (arg === '') {
    const cur = getSessionAccent()
    const overridden = getSessionAccentOverride() !== null
    return (
      `accent ${cur.accent}${overridden ? ' (operator override)' : ` (${cur.name} — derived)`}\n` +
      `usage: /appearance accent <name|#hex|reset> — session-only, re-tints the whole identity chrome live\n` +
      `names: ${Object.keys(ACCENT_NAMED).join(' · ')}`
    )
  }
  if (arg === 'reset' || arg === 'default' || arg === 'off') {
    const changed = setSessionAccentOverride(null)
    return changed
      ? `accent override cleared — back to the derived chain (critter/fable): now ${getSessionAccent().accent}`
      : 'no accent override was active'
  }
  const hex = ACCENT_NAMED[arg] ?? arg
  const ok = setSessionAccentOverride(hex)
  if (!ok) {
    return `not a colour I can use: '${rawArg.trim()}' — try a name (${Object.keys(ACCENT_NAMED).join(' · ')}) or #RRGGBB`
  }
  return `accent → ${getSessionAccent().accent}${ACCENT_NAMED[arg] ? ` (${arg})` : ''} — session-only · /appearance accent reset restores the critter accent`
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const words = args.trim().split(/\s+/)
  if (words[0] === 'accent') {
    const receipt = accentReceipt(words.slice(1).join(' '))
    const chat = getFocusedSessionConnector()
    if (chat.addDisplayRow === undefined) {
      onDone(receipt, { display: 'system' })
      return null
    }
    chat.addDisplayRow(createUserMessage({ content: formatCommandInputTags('appearance', args.trim()) }))
    chat.addDisplayRow(createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${receipt}</${LOCAL_COMMAND_STDOUT_TAG}>`))
    onDone(undefined, { display: 'skip' })
    return null
  }
  return <AppearanceCenter onDone={onDone} />
}
