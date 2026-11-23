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
  onChoice,
}: {
  error: ConfigParseError
  backupPath: string | null
  onChoice: (choice: Choice) => void
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

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.failure}
      paddingX={1}
      gap={1}
    >
      <Text bold color={tokens.failure}>
        Configuration file is corrupted
      </Text>
      <Box flexDirection="column">
        <Text>
          The configuration file at <Text bold>{error.filePath}</Text> could
          not be parsed:
        </Text>
        <Text dimColor>{error.message}</Text>
        {backupPath !== null && (
          <Text>
            The newest good copy is at <Text bold>{backupPath}</Text> — restoring it keeps your account,
            trust grants and project records.
          </Text>
        )}
      </Box>
      <Select
        options={options}
        onChange={onChoice}
        onCancel={() => onChoice('exit')}
      />
      <Text dimColor>↑↓ move · ↵ select · esc exit</Text>
    </Box>
  )
}

export async function showInvalidConfigDialog({
  error,
}: {
  error: ConfigParseError
}): Promise<void> {
  const backupPath = lookupNewestBackup(error.filePath)
  const onChoice = (choice: Choice): void => {
    if (choice === 'exit') {
      gracefulShutdownSync(1)
      return
    }
    if (choice === 'restore' && backupPath !== null) {
      try {
        const { quarantinePath } = restoreConfigFromBackup(error.filePath, backupPath)
        const kept = quarantinePath ? ` — the corrupt bytes are kept at ${quarantinePath}` : ''
        writeStderrLine(
          `mercury: the configuration was restored from ${backupPath}${kept}. Start Mercury again.`,
        )
        gracefulShutdownSync(0)
      } catch (err) {
        logError(err)
        const detail = err instanceof Error ? err.message : String(err)
        writeStderrLine(
          `mercury: the restore from ${backupPath} failed (${detail}) — the file is unchanged; copy it by hand: cp "${backupPath}" "${error.filePath}"`,
        )
        gracefulShutdownSync(1)
      }
      return
    }
    if (choice === 'reset') {
      const quarantinePath = quarantineBeforeReset(error.filePath)
      try {
        writeFileSync(error.filePath, `${JSON.stringify(error.defaultConfig, null, 2)}\n`, 'utf8')
        const kept = quarantinePath ? ` — the corrupt bytes are kept at ${quarantinePath}` : ''
        writeStderrLine(
          `mercury: the configuration was reset to defaults${kept}. Start Mercury again.`,
        )
        gracefulShutdownSync(0)
      } catch (err) {
        logError(err)
        const detail = err instanceof Error ? err.message : String(err)
        writeStderrLine(
          `mercury: the reset could not write ${error.filePath} (${detail}) — the file is unchanged; fix or replace it by hand.`,
        )
        gracefulShutdownSync(1)
      }
    }
  }
  await render(
    <AppStateProvider>
      <KeybindingSetup>
        <ThemeProvider initialState={DEFAULT_THEME_SETTING}>
          <InvalidConfigView error={error} backupPath={backupPath} onChoice={onChoice} />
        </ThemeProvider>
      </KeybindingSetup>
    </AppStateProvider>,
    { exitOnCtrlC: true },
  )
  await new Promise<void>(() => {})
}

export default showInvalidConfigDialog
