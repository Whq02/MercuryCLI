// IDE onboarding card: first Mercury run inside a connected IDE
// terminal. Marks itself shown ON RENDER, keyed per terminal identity
// (unknown terminals share one key). Enter or the decline chord dismisses.

import React, { useEffect } from 'react'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { envDynamic } from '../utils/envDynamic.js'
import {
  type IDEExtensionInstallationStatus,
  getTerminalIdeType,
  isJetBrainsIde,
  toIDEDisplayName,
} from '../utils/ide.js'

const UNKNOWN_TERMINAL_KEY = 'unknown'

function terminalKey(): string {
  return envDynamic.terminal ?? UNKNOWN_TERMINAL_KEY
}

export function hasIdeOnboardingDialogBeenShown(): boolean {
  return getGlobalConfig().hasIdeOnboardingBeenShown?.[terminalKey()] === true
}

export function IdeOnboardingDialog({
  onDone,
  installationStatus,
}: {
  onDone: () => void
  installationStatus: IDEExtensionInstallationStatus | null
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const ideType = getTerminalIdeType()
  const ideName = toIDEDisplayName(envDynamic.terminal)
  const jetBrains = isJetBrainsIde(ideType)
  const artifactWord = jetBrains ? 'plugin' : 'extension'
  const version = installationStatus?.installedVersion ?? null
  const isMac = process.platform === 'darwin'
  const referenceChord = isMac ? 'Cmd+Option+K' : 'Ctrl+Alt+K'
  const quickLaunchChord = isMac ? 'Cmd+Esc' : 'Ctrl+Esc'

  // Shown-flag stamped on render, per terminal identity.
  useEffect(() => {
    const key = terminalKey()
    saveGlobalConfig(current =>
      current.hasIdeOnboardingBeenShown?.[key] === true
        ? current
        : {
            ...current,
            hasIdeOnboardingBeenShown: {
              ...(current.hasIdeOnboardingBeenShown ?? {}),
              [key]: true,
            },
          },
    )
  }, [])

  useKeybinding('confirm:yes', onDone, { context: 'Confirmation' })
  useKeybinding('confirm:no', onDone, { context: 'Confirmation' })

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={tokens.info}
        paddingX={1}
        gap={1}
      >
        <Box flexDirection="column">
          <Text bold>Welcome to Mercury in {ideName}</Text>
          {version !== null ? (
            <Text dimColor>
              {artifactWord} version {version}
            </Text>
          ) : null}
        </Box>
        <Box flexDirection="column">
          <Text>
            Mercury can see the files you have open and the lines you select
            in {ideName}.
          </Text>
          <Text>
            File changes can be reviewed as a diff directly in the IDE.
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text>
            {quickLaunchChord} launches Mercury from anywhere in the IDE.
          </Text>
          <Text>
            {referenceChord} inserts a reference to the current file or
            selected lines into the input.
          </Text>
        </Box>
      </Box>
      <Text dimColor italic>
        Press Enter to continue
      </Text>
    </Box>
  )
}

export default IdeOnboardingDialog
