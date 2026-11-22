import React, { useRef, useState } from 'react'
import { useClaim, useMeasure } from '../hooks/effects.js'
import { exitChordNoticeText } from './PromptInput/ExitChordNotice.js'
import { Box, Text } from '../ink.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useSettings } from '../hooks/useSettings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import useApp from '../ink/hooks/use-app.js'
import type { DOMElement } from '../ink/dom.js'
import measureElement from '../ink/measure-element.js'
import { useRegisterKeybindingContext } from '../keybindings/KeybindingContext.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { useSetAppState } from '../state/AppState.js'
import type { StructuredPatchHunk } from '../utils/diff.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { DEFAULT_THEME_SETTING } from '../utils/systemTheme.js'
import { isMonochromeTheme, REACHABLE_THEME_SETTINGS, THEME_LABELS, type ThemeSetting } from '../utils/theme.js'
import { Select, type OptionWithDescription } from './CustomSelect/index.js'
import Byline from './design-system/Byline.js'
import Divider from './design-system/Divider.js'
import {
  usePreviewTheme,
  useTheme,
  useThemeSetting,
} from './design-system/ThemeProvider.js'
import { StructuredDiff } from './StructuredDiff.js'
import {
  expectColorDiff,
  getColorModuleUnavailableReason,
  getSyntaxTheme,
} from './StructuredDiff/colorDiff.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type ThemePickerProps = Unbuilt

const THEME_LABELS_BY_SETTING: Record<string, string> = THEME_LABELS
const THEME_DESCRIPTIONS_BY_SETTING: Record<string, string> = {
  dark: 'the oasis ground — the Mercury identity',
  'true-black': 'the same palette on a pure-black ground',
  mono: 'no colour at all — the terminal’s own ink on its own ground',
}
const THEME_OPTIONS: OptionWithDescription<string>[] = REACHABLE_THEME_SETTINGS.map(
  setting => ({
    label: THEME_LABELS_BY_SETTING[setting] ?? setting,
    value: setting,
    description: `${THEME_DESCRIPTIONS_BY_SETTING[setting] ?? 'a Mercury appearance'}${setting === DEFAULT_THEME_SETTING ? ' (default)' : ''}`,
  }),
)

const DEMO_FILE_PATH = 'greet.ts'
const DEMO_FIRST_LINE = 'export function greet(name: string): string {'
const DEMO_PATCH: StructuredPatchHunk = {
  oldStart: 1,
  oldLines: 3,
  newStart: 1,
  newLines: 3,
  lines: [
    ' export function greet(name: string): string {',
    "-  return 'Hello, ' + name",
    '+  return `Hello, ${name}!`',
    ' }',
  ],
}

const noop = (): void => {}

export function ThemePicker(arg0: ThemePickerProps): React.ReactNode {
  return notBuilt('src/components/ThemePicker.tsx:77')
}

export default ThemePicker
