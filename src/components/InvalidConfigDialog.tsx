
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

type Choice = 'exit' | 'reset' | 'restore'

function InvalidConfigDialogInner({
  error,
  backupPath,
  onChoice,
}: {
  error: ConfigParseError
  backupPath: string | null
  onChoice: (choice: Choice) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tokens.failure} paddingX={1} gap={1}>
      <Text bold color={tokens.failure}>
        Configuration file is corrupted
      </Text>
      <Box flexDirection="column">
        <Text>
          The configuration file at <Text bold>{error.filePath}</Text> could
          not be parsed:
        </Text>
        <Text dimColor>{error.message}</Text>
        {backupPath !== null ? (
          <Text>
            The newest good copy is at <Text bold>{backupPath}</Text> — restoring it keeps your account,
            trust grants and project records.
          </Text>
        ) : null}
      </Box>
      <Select
        options={[
          ...(backupPath !== null
            ? [{ label: `Restore the newest backup (${basename(backupPath)})`, value: 'restore' }]
            : []),
          { label: 'Exit and fix the file by hand', value: 'exit' },
          { label: 'Reset it to the default configuration (discards account, trust grants, project records)', value: 'reset' },
        ]}
        onChange={value => onChoice(value as Choice)}
        onCancel={() => onChoice('exit')}
      />
      <Text dimColor>↑↓ move · ↵ select · esc exit</Text>
    </Box>
  )
}

export function showInvalidConfigDialog({
  error,
}: {
  error: ConfigParseError
}): Promise<void> {
  let backupPath: string | null = null
  try {
    backupPath = findMostRecentBackup(error.filePath)
  } catch {
    backupPath = null
  }
  return new Promise<void>(() => {
    render(
      <AppStateProvider>
        <KeybindingSetup>
          <ThemeProvider initialState="dark">
            <InvalidConfigDialogInner
              error={error}
              backupPath={backupPath}
              onChoice={choice => {
                if (choice === 'restore' && backupPath !== null) {
                  try {
                    const { quarantinePath } = restoreConfigFromBackup(error.filePath, backupPath)
                    try {
                      writeSync(
                        2,
                        `mercury: the configuration was restored from ${backupPath}${quarantinePath ? ` — the corrupt bytes are kept at ${quarantinePath}` : ''}. Start Mercury again.\n`,
                      )
                    } catch {
                    }
                    gracefulShutdownSync(0)
                  } catch (restoreError) {
                    logError(restoreError)
                    try {
                      writeSync(
                        2,
                        `mercury: the restore from ${backupPath} failed (${restoreError instanceof Error ? restoreError.message : String(restoreError)}) — the file is unchanged; copy it by hand: cp "${backupPath}" "${error.filePath}"\n`,
                      )
                    } catch {
                    }
                    gracefulShutdownSync(1)
                  }
                  return
                }
                if (choice === 'reset') {
                  let quarantinePath: string | null = null
                  try {
                    const dir = getConfigBackupDir()
                    mkdirSync(dir, { recursive: true })
                    quarantinePath = join(dir, `${basename(error.filePath)}.corrupted.reset-${Date.now()}`)
                    copyFileSync(error.filePath, quarantinePath)
                  } catch {
                    quarantinePath = null
                  }
                  try {
                    writeFileSync(
                      error.filePath,
                      JSON.stringify(error.defaultConfig, null, 2) + '\n',
                      'utf8',
                    )
                  } catch (writeError) {
                    logError(writeError)
                    try {
                      writeSync(
                        2,
                        `mercury: the reset could not write ${error.filePath} (${writeError instanceof Error ? writeError.message : String(writeError)}) — the file is unchanged; fix or replace it by hand.\n`,
                      )
                    } catch {
                    }
                    gracefulShutdownSync(1)
                    return
                  }
                  try {
                    writeSync(
                      2,
                      `mercury: the configuration was reset to defaults${quarantinePath ? ` — the corrupt bytes are kept at ${quarantinePath}` : ''}.\n`,
                    )
                  } catch {
                  }
                  gracefulShutdownSync(0)
                } else {
                  gracefulShutdownSync(1)
                }
              }}
            />
          </ThemeProvider>
        </KeybindingSetup>
      </AppStateProvider>,
      { exitOnCtrlC: true },
    )
  })
}

export default showInvalidConfigDialog
