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
import { notBuilt } from '../pi/holes.js'

type Choice = 'exit' | 'reset' | 'restore'

export function showInvalidConfigDialog(arg0: {
  error: ConfigParseError
}): Promise<void> {
  return notBuilt('src/components/InvalidConfigDialog.tsx:63')
}

export default showInvalidConfigDialog
