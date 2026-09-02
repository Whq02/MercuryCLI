// The theme chooser: live preview on focus, save on Enter, and a syntax-
// highlighting demo diff so the choice is made against real output. EVERY
// unmount releases an unsaved preview — close paths that bypass the
// select's cancel (a click-close row on a containing shell) would otherwise
// leave the previewed theme applied product-wide until restart.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { REACHABLE_THEME_SETTINGS, type ThemeSetting } from '../utils/theme.js'
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

export type ThemePickerProps = {
  onThemeSelect: (setting: ThemeSetting) => void
  showIntroText?: boolean
  helpText?: string
  showHelpTextBelow?: boolean
  hideEscToCancel?: boolean
  hideTitle?: boolean
  skipExitHandling?: boolean
  onCancel?: () => void
}

/** The user-reachable rows (operator ruling: TWO appearances — the oasis
 *  dark identity and True Black; REACHABLE_THEME_SETTINGS is the
 *  vocabulary; the other families stay dormant behind the
 *  MERCURY_THEME_PIN gate). */
const THEME_LABELS_BY_SETTING: Record<string, string> = {
  dark: 'Oasis dark',
  'true-black': 'True Black',
}
const THEME_DESCRIPTIONS_BY_SETTING: Record<string, string> = {
  dark: 'the oasis ground — the Mercury identity',
  'true-black': 'the same palette on a pure-black ground',
}
const THEME_OPTIONS: OptionWithDescription<string>[] = REACHABLE_THEME_SETTINGS.map(
  setting => ({
    label: THEME_LABELS_BY_SETTING[setting] ?? setting,
    value: setting,
    description: THEME_DESCRIPTIONS_BY_SETTING[setting] ?? 'a Mercury appearance',
  }),
)

// The demo diff: a four-line hunk showing a one-line replacement in a small
// script; the file path's extension picks the highlight language.
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

export function ThemePicker({
  onThemeSelect,
  showIntroText = false,
  helpText,
  showHelpTextBelow = false,
  hideEscToCancel = false,
  hideTitle = false,
  skipExitHandling = false,
  onCancel,
}: ThemePickerProps): React.ReactNode {
  const savedSetting = useThemeSetting()
  const [themeName] = useTheme()
  const { setPreviewTheme, savePreview, cancelPreview } = usePreviewTheme()
  const { columns } = useTerminalSize()
  const settings = useSettings()
  const setAppState = useSetAppState()
  const app = useApp()

  useRegisterKeybindingContext('ThemePicker')
  // With exit handling delegated, a no-op exit callback keeps the built-in
  // ctrl+C/D exit from acting.
  const exitState = useExitOnCtrlCDWithKeybindings(
    skipExitHandling ? noop : undefined,
  )

  // Release an unsaved preview on EVERY unmount path, through a ref (the
  // provider's callback identity churns). A save or an ordinary
  // escape-cancel leaves no preview, making this a no-op there.
  const cancelPreviewRef = useRef(cancelPreview)
  cancelPreviewRef.current = cancelPreview
  useEffect(
    () => () => {
      cancelPreviewRef.current()
    },
    [],
  )

  // The demo renders at the width actually available (the appearance shell
  // embeds this picker inside a bordered card narrower than the terminal);
  // measured per commit with the terminal width as the first-paint estimate.
  const demoBoxRef = useRef<DOMElement | null>(null)
  const [measuredDemoWidth, setMeasuredDemoWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = demoBoxRef.current
    if (!el) return
    const { width } = measureElement(el)
    if (typeof width === 'number' && width > 0 && width !== measuredDemoWidth) {
      setMeasuredDemoWidth(width)
    }
  })
  const demoWidth = measuredDemoWidth ?? columns

  const colorModuleAvailable =
    getColorModuleUnavailableReason() === null && expectColorDiff() !== null
  const toggleChord = useShortcutDisplay(
    'theme:toggleSyntaxHighlighting',
    'ThemePicker',
    'ctrl+t',
  )
  useKeybinding(
    'theme:toggleSyntaxHighlighting',
    () => {
      const next = !settings.syntaxHighlightingDisabled
      updateSettingsForSource('userSettings', {
        syntaxHighlightingDisabled: next,
      })
      // Mirror into app state so the demo repaints without waiting for the
      // file-change detector.
      setAppState(prev => ({
        ...prev,
        settings: { ...prev.settings, syntaxHighlightingDisabled: next },
      }))
    },
    { context: 'ThemePicker', isActive: colorModuleAvailable },
  )

  // Exactly one of the highlighting states.
  let statusLine: string
  if (settings.syntaxHighlightingDisabled) {
    statusLine = `Syntax highlighting disabled (${toggleChord} to enable)`
  } else {
    const syntaxTheme = getSyntaxTheme(themeName)
    if (syntaxTheme) {
      const source = syntaxTheme.source ? ` from ${syntaxTheme.source}` : ''
      statusLine = `Syntax theme: ${syntaxTheme.theme}${source} (${toggleChord} to disable)`
    } else {
      statusLine = `Syntax highlighting enabled (${toggleChord} to disable)`
    }
  }

  const helpAbove =
    helpText !== undefined && helpText !== '' && !showHelpTextBelow
  const helpBelow =
    helpText !== undefined && helpText !== '' && showHelpTextBelow

  const content = (
    <Box flexDirection="column">
      {showIntroText ? (
        <Text>Welcome — pick how the terminal should look.</Text>
      ) : !hideTitle ? (
        <Text bold color="permission">
          Theme
        </Text>
      ) : null}
      <Text bold>The Mercury appearance:</Text>
      {helpAbove ? <Text dimColor>{helpText}</Text> : null}
      <Select
        options={THEME_OPTIONS}
        defaultValue={THEME_OPTIONS.some(o => o.value === savedSetting) ? savedSetting : 'dark'}
        defaultFocusValue={THEME_OPTIONS.some(o => o.value === savedSetting) ? savedSetting : 'dark'}
        visibleOptionCount={THEME_OPTIONS.length}
        onFocus={value => {
          setPreviewTheme(value)
        }}
        onChange={value => {
          savePreview()
          onThemeSelect(value)
        }}
        onCancel={() => {
          cancelPreview()
          if (onCancel) onCancel()
          else app.exit()
        }}
      />
      {helpBelow && !showIntroText ? (
        <Box paddingLeft={3}>
          <Text dimColor>{helpText}</Text>
        </Box>
      ) : null}
      <Box ref={demoBoxRef} flexDirection="column">
        <Divider char="┄" color="subtle" width={demoWidth} />
        <StructuredDiff
          patch={DEMO_PATCH}
          dim={false}
          filePath={DEMO_FILE_PATH}
          firstLine={DEMO_FIRST_LINE}
          width={demoWidth}
        />
        <Divider char="┄" color="subtle" width={demoWidth} />
      </Box>
      <Box height={1} />
      <Text dimColor>{statusLine}</Text>
    </Box>
  )

  if (showIntroText) return content

  return (
    <Box flexDirection="column">
      {content}
      <Box marginTop={1}>
        {exitState.pending ? (
          <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
        ) : (
          <Text dimColor>
            <Byline>
              <Text dimColor>enter to select</Text>
              {!hideEscToCancel ? <Text dimColor>esc to cancel</Text> : null}
            </Byline>
          </Text>
        )}
      </Box>
    </Box>
  )
}

export default ThemePicker
