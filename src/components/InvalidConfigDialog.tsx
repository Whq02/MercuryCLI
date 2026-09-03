// Corrupt-config recovery: the global config file failed to parse.
// Renders on its own root with a HARD-CODED dark theme (reading the theme
// would re-read the very config that failed), names the offending file and
// the parser's message, and offers exit-to-fix-by-hand (exit 1) or
// overwrite-with-defaults (exit 0). Escape is exit.
//
// The root mounts the SAME provider pair showSetupDialog mounts (app state
// + keybindings): the Select's whole grammar — ↑↓/↵/esc — dispatches
// through the rebindable layer, and on a bare root those keys silently
// never registered, leaving the gate deaf to every key it advertises
// except the raw-path digits (the DEGRADED-invalid-config-gate-keys-
// dead). Both providers are safe here: post-gate config reads degrade to
// defaults, and nothing in this tree changes the app state keys whose
// change handlers persist to disk.

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

type Choice = 'exit' | 'reset' | 'restore'

function InvalidConfigDialogInner({
  error,
  backupPath,
  onChoice,
}: {
  error: ConfigParseError
  /** The newest good copy the save path kept, or null (FN-015 rank 65). */
  backupPath: string | null
  onChoice: (choice: Choice) => void
}): React.ReactNode {
  // Safe here: the enclosing ThemeProvider is pinned to the default
  // appearance, so the token resolution never re-reads the (broken) config
  // file.
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
  // The newest good copy, looked up once: the gate's non-destructive road.
  let backupPath: string | null = null
  try {
    backupPath = findMostRecentBackup(error.filePath)
  } catch {
    backupPath = null
  }
  return new Promise<void>(() => {
    // The promise never resolves — every choice ends the process.
    render(
      <AppStateProvider>
        <KeybindingSetup>
          <ThemeProvider initialState={DEFAULT_THEME_SETTING}>
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
                      /* best-effort notice */
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
                      /* a closed fd must not mask the exit */
                    }
                    gracefulShutdownSync(1)
                  }
                  return
                }
                if (choice === 'reset') {
                  // Quarantine the corrupt bytes FIRST (the read path's own
                  // contract — recovery stays possible; the reset arm alone
                  // destroyed the only copy of the operator's trust grants
                  // and account records over a trailing comma; TASK-017 S2,
                  // corrupt-config-reset-exits-silently + the
                  // invalid-config-reset-no-quarantine moderate). Fail-soft:
                  // a refused quarantine never blocks the reset.
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
                    // SAY IT (writeSync — the exit road's law): this arm
                    // exited 1 with not one word, indistinguishable from
                    // 'Exit and fix by hand', so the operator concluded the
                    // reset happened and met the same gate next boot.
                    try {
                      writeSync(
                        2,
                        `mercury: the reset could not write ${error.filePath} (${writeError instanceof Error ? writeError.message : String(writeError)}) — the file is unchanged; fix or replace it by hand.\n`,
                      )
                    } catch {
                      /* a closed fd must not mask the exit */
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
                    /* best-effort notice */
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
