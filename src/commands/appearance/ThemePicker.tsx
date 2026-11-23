import React, { useRef, useState } from 'react'
import { useClaim, useMeasure } from '../../screen/effects/effects.js'
import { exitChordNoticeText } from '../../screen/composer/ExitChordNotice.js'
import { Box, Text } from '../../screen/themedRenderer.js'
import { useExitOnCtrlCDWithKeybindings } from '../../screen/keys/useExitChordKeys.js'
import { useSettings } from '../../screen/settings/useSettings.js'
import { useTerminalSize } from '../../screen/fullscreen-layout/useTerminalSize.js'
import useApp from '../../screen/renderer/bindings/use-app.js'
import type { DOMElement } from '../../screen/renderer/dom.js'
import measureElement from '../../screen/renderer/measure-element.js'
import { useRegisterKeybindingContext } from '../../screen/keys/KeybindingContext.js'
import { useKeybinding } from '../../screen/keys/useKeybinding.js'
import { useShortcutDisplay } from '../../screen/keys/useShortcutDisplay.js'
import { useSetAppState } from '../../screen/app-state/AppState.js'
import type { StructuredPatchHunk } from '../../platform/text/diff.js'
import { updateSettingsForSource } from '../../platform/settings/settings.js'
import { DEFAULT_THEME_SETTING } from '../../screen/theme/systemTheme.js'
import { isMonochromeTheme, REACHABLE_THEME_SETTINGS, THEME_LABELS, type ThemeSetting } from '../../screen/theme/theme.js'
import { Select, type OptionWithDescription } from '../../screen/select/index.js'
import Byline from '../../screen/theme/Byline.js'
import Divider from '../../screen/theme/Divider.js'
import {
  usePreviewTheme,
  useTheme,
  useThemeSetting,
} from '../../screen/theme/ThemeProvider.js'
import { StructuredDiff } from '../../screen/structured-diff/StructuredDiff.js'
import {
  expectColorDiff,
  getColorModuleUnavailableReason,
  getSyntaxTheme,
} from '../../screen/structured-diff/colorDiff.js'

type ThemePickerProps = {
  onThemeSelect: (theme: ThemeSetting) => void
  showIntroText?: boolean
  helpText?: string
  showHelpTextBelow?: boolean
  hideEscToCancel?: boolean
  hideTitle?: boolean
  skipExitHandling?: boolean
  onCancel?: () => void
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
  onThemeSelect,
  showIntroText = false,
  helpText,
  showHelpTextBelow = false,
  hideEscToCancel = false,
  hideTitle = false,
  skipExitHandling = false,
  onCancel,
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
  )

  const cancelPreviewRef = useRef(cancelPreview)
  cancelPreviewRef.current = cancelPreview

  useClaim(
    () => () => {
      cancelPreviewRef.current()
    },
    [],
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
  })

  const syntaxOff = settings.view?.syntaxOff ?? false
  const colorDiffAvailable =
    getColorModuleUnavailableReason() === null && expectColorDiff() !== null
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

  const initial = toThemeSetting(savedThemeSetting)
  const previewWidth =
    measuredWidth !== null && measuredWidth > 0 ? measuredWidth : columns

  let syntaxStatusLine: string
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

  const hasHelpText = helpText !== undefined && helpText !== ''
  const showHelpAbove = hasHelpText && !showHelpTextBelow
  const showHelpBelow = hasHelpText && showHelpTextBelow

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
      {showHelpAbove && <Text dimColor>{helpText}</Text>}
      <Select
        options={THEME_OPTIONS}
        defaultValue={initial}
        defaultFocusValue={initial}
        visibleOptionCount={THEME_OPTIONS.length}
        onFocus={handleFocus}
        onChange={handleSelect}
        onCancel={handleCancel}
      />
      {showHelpBelow && !showIntroText && (
        <Box paddingLeft={3}>
          <Text dimColor>{helpText}</Text>
        </Box>
      )}
      <Box ref={previewRef} flexDirection="column">
        <Divider char="┄" color="subtle" width={previewWidth} />
        <StructuredDiff
          patch={DEMO_PATCH}
          dim={false}
          filePath={DEMO_FILE_PATH}
          firstLine={DEMO_FIRST_LINE}
          width={previewWidth}
        />
        <Divider char="┄" color="subtle" width={previewWidth} />
      </Box>
      <Box height={1} />
      <Text dimColor>{syntaxStatusLine}</Text>
    </Box>
  )

  if (showIntroText) {
    return content
  }

  return (
    <Box flexDirection="column">
      {content}
      <Box marginTop={1}>
        {exitState.pending ? (
          <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
        ) : (
          <Text dimColor>
            <Byline>
              <Text dimColor>↑↓ move · ↵ select</Text>
              {!hideEscToCancel && <Text dimColor>esc to cancel</Text>}
            </Byline>
          </Text>
        )}
      </Box>
    </Box>
  )
}

export default ThemePicker
