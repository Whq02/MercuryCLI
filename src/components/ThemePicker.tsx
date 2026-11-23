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

type ThemePickerProps = {
  initialTheme?: ThemeSetting
  onThemeSelect: (theme: ThemeSetting) => void
  onCancel?: () => void
  showIntroText?: boolean
  hideBorder?: boolean
  hideTitle?: boolean
  hideEscToCancel?: boolean
  skipExitHandling?: boolean
}

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

function toThemeSetting(value: string): ThemeSetting {
  for (const setting of REACHABLE_THEME_SETTINGS) {
    if (setting === value) return setting
  }
  return DEFAULT_THEME_SETTING
}

export function ThemePicker({
  initialTheme,
  onThemeSelect,
  onCancel,
  showIntroText = false,
  hideTitle = false,
  hideEscToCancel = false,
  skipExitHandling = false,
}: ThemePickerProps): React.ReactNode {
  useRegisterKeybindingContext('ThemePicker')

  const [resolvedTheme, setThemeSetting] = useTheme()
  const savedThemeSetting = useThemeSetting()
  const { setPreviewTheme, cancelPreview } = usePreviewTheme()
  const settings = useSettings()
  const setAppState = useSetAppState()
  const { columns } = useTerminalSize()
  const app = useApp()
  const exitState = useExitOnCtrlCDWithKeybindings(
    skipExitHandling ? noop : undefined,
    undefined,
    !skipExitHandling,
  )

  useClaim(
    () => () => {
      cancelPreview()
    },
    [cancelPreview],
  )

  const previewRef = useRef<DOMElement>(null)
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null)

  useMeasure(() => {
    const node = previewRef.current
    if (!node) return
    const { width } = measureElement(node)
    if (width > 0 && width !== measuredWidth) {
      setMeasuredWidth(width)
    }
  }, [columns, measuredWidth])

  const syntaxOff = settings.view?.syntaxOff ?? false
  const colorDiffAvailable =
    expectColorDiff() !== null && getColorModuleUnavailableReason() === null
  const toggleSyntaxChord = useShortcutDisplay(
    'theme:toggleSyntaxHighlighting',
    'ThemePicker',
    'ctrl+t',
  )

  useKeybinding(
    'theme:toggleSyntaxHighlighting',
    () => {
      const nextSyntaxOff = !syntaxOff
      updateSettingsForSource('userSettings', { view: { syntaxOff: nextSyntaxOff } })
      setAppState(prev => ({
        ...prev,
        settings: {
          ...prev.settings,
          view: {
            ...prev.settings.view,
            syntaxOff: nextSyntaxOff,
          },
        },
      }))
    },
    { context: 'ThemePicker', isActive: colorDiffAvailable },
  )

  const initial = initialTheme ?? savedThemeSetting
  const previewWidth =
    measuredWidth !== null && measuredWidth > 0 ? measuredWidth : columns

  let syntaxStatusLine: string | null = null
  if (colorDiffAvailable) {
    if (syntaxOff) {
      syntaxStatusLine = `Syntax highlighting disabled (${toggleSyntaxChord} to enable)`
    } else if (isMonochromeTheme(resolvedTheme)) {
      syntaxStatusLine = `Syntax highlighting enabled — no colour on Black and white (${toggleSyntaxChord} to disable)`
    } else {
      const syntaxTheme = getSyntaxTheme(resolvedTheme)
      if (syntaxTheme) {
        const fromSource = syntaxTheme.source ? ` from ${syntaxTheme.source}` : ''
        syntaxStatusLine = `Syntax theme: ${syntaxTheme.theme}${fromSource} (${toggleSyntaxChord} to disable)`
      } else {
        syntaxStatusLine = `Syntax highlighting enabled (${toggleSyntaxChord} to disable)`
      }
    }
  }

  const handleFocus = (value: string): void => {
    setPreviewTheme(toThemeSetting(value))
  }

  const handleSelect = (value: string): void => {
    const setting = toThemeSetting(value)
    setThemeSetting(setting)
    onThemeSelect(setting)
  }

  const handleCancel = (): void => {
    cancelPreview()
    if (onCancel) {
      onCancel()
    } else {
      app.exit()
    }
  }

  return (
    <Box flexDirection="column">
      {showIntroText ? (
        <Text>Welcome — pick how the terminal should look.</Text>
      ) : !hideTitle ? (
        <Text bold>Theme</Text>
      ) : null}
      <Text>The Mercury appearance:</Text>
      <Select
        options={THEME_OPTIONS}
        defaultValue={initial}
        defaultFocusValue={initial}
        onFocus={handleFocus}
        onChange={handleSelect}
        onCancel={handleCancel}
      />
      <Box ref={previewRef} flexDirection="column" width="100%">
        <Divider width={previewWidth} char="┄" />
        <StructuredDiff
          patch={DEMO_PATCH}
          dim={false}
          width={previewWidth}
          filePath={DEMO_FILE_PATH}
          firstLine={DEMO_FIRST_LINE}
        />
        <Divider width={previewWidth} char="┄" />
      </Box>
      {syntaxStatusLine !== null && (
        <Box marginTop={1}>
          <Text dimColor>{syntaxStatusLine}</Text>
        </Box>
      )}
      {!showIntroText && (
        <Box marginTop={1}>
          {exitState.pending ? (
            <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
          ) : (
            <Text dimColor>
              <Byline>
                <Text>↑↓ move</Text>
                <Text>↵ select</Text>
                {!hideEscToCancel && <Text>esc to cancel</Text>}
              </Byline>
            </Text>
          )}
        </Box>
      )}
    </Box>
  )
}

export default ThemePicker
