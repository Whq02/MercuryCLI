import React from 'react'
import { copyFileSync, mkdirSync, writeFileSync, writeSync } from 'fs'
import { basename, join } from 'path'
import { Box, Text, render, ThemeProvider } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import type { ConfigParseError } from '../utils/errors.js'
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js'
import { findMostRecentBackup, getConfigBackupDir, restoreConfigFromBackup } from '../utils/config/globalConfig.js'
import { logError } from '../utils/log.js'
import { DEFAULT_THEME_SETTING } from '../utils/systemTheme.js'
import { passedOver } from '../utils/passedOver.js'

type Choice = 'exit' | 'reset' | 'restore'

function writeStderrLine(line: string): void {
  writeSync(2, `${line}\n`)
}

function lookupNewestBackup(filePath: string): string | null {
  try {
    return findMostRecentBackup(filePath)
  } catch (err) {
    passedOver(err)
    return null
  }
}

function quarantineBeforeReset(filePath: string): string | null {
  try {
    const dir = getConfigBackupDir()
    mkdirSync(dir, { recursive: true })
    const quarantinePath = join(dir, `${basename(filePath)}.corrupted.reset-${Date.now()}`)
    copyFileSync(filePath, quarantinePath)
    return quarantinePath
  } catch (err) {
    passedOver(err)
    return null
  }
}

function InvalidConfigView({
  error,
  backupPath,
}: {
  error: ConfigParseError
  backupPath: string | null
}): React.ReactNode {
  const tokens = useMercuryTokens()

  const options: Array<{ label: string; value: Choice }> = [
    ...(backupPath !== null
      ? [{ label: `Restore the newest backup (${basename(backupPath)})`, value: 'restore' as const }]
      : []),
    { label: 'Exit and fix the file by hand', value: 'exit' },
    {
      label: 'Reset it to the default configuration (discards account, trust grants, project records)',
      value: 'reset',
    },
  ]

  const handleExit = (): void => {
    gracefulShutdownSync(1)
  }

  const handleSelect = (choice: Choice): void => {
    if (choice === 'exit') {
      handleExit()
      return
    }
    if (choice === 'restore' && backupPath !== null) {
      try {
        const { quarantinePath } = restoreConfigFromBackup(error.filePath, backupPath)
        const suffix = quarantinePath ? ` (corrupted copy saved at ${quarantinePath})` : ''
        writeStderrLine(`Restored ${error.filePath} from ${backupPath}${suffix}.`)
        gracefulShutdownSync(0)
      } catch (err) {
        logError(err)
        const detail = err instanceof Error ? err.message : String(err)
        writeStderrLine(`Could not restore backup (${detail}). Restore manually with:`)
        writeStderrLine(`  cp ${JSON.stringify(backupPath)} ${JSON.stringify(error.filePath)}`)
        gracefulShutdownSync(1)
      }
      return
    }
    if (choice === 'reset') {
      const quarantinePath = quarantineBeforeReset(error.filePath)
      try {
        writeFileSync(error.filePath, `${JSON.stringify(error.defaultConfig, null, 2)}\n`, 'utf8')
        const suffix = quarantinePath ? ` (corrupted copy saved at ${quarantinePath})` : ''
        writeStderrLine(`Reset ${error.filePath} to default configuration${suffix}.`)
        gracefulShutdownSync(0)
      } catch (err) {
        logError(err)
        const detail = err instanceof Error ? err.message : String(err)
        writeStderrLine(`Could not write default configuration to ${error.filePath}: ${detail}`)
        gracefulShutdownSync(1)
      }
    }
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.failure}
      padding={1}
      gap={1}
    >
      <Text bold color={tokens.failureText}>
        Configuration file is corrupted
      </Text>
      <Box flexDirection="column">
        <Text color={tokens.textPrimary}>{error.filePath}</Text>
        <Text color={tokens.textSecondary}>{error.message}</Text>
        {backupPath !== null ? (
          <Text color={tokens.textMuted}>Newest backup: {backupPath}</Text>
        ) : null}
      </Box>
      <Select options={options} onChange={handleSelect} onCancel={handleExit} />
    </Box>
  )
}

export async function showInvalidConfigDialog({
  error,
}: {
  error: ConfigParseError
}): Promise<void> {
  const backupPath = lookupNewestBackup(error.filePath)
  await render(
    <AppStateProvider>
      <KeybindingSetup>
        <ThemeProvider initialState={DEFAULT_THEME_SETTING}>
          <InvalidConfigView error={error} backupPath={backupPath} />
        </ThemeProvider>
      </KeybindingSetup>
    </AppStateProvider>,
    { exitOnCtrlC: true },
  )
  await new Promise<void>(() => {})
}

export default showInvalidConfigDialog
