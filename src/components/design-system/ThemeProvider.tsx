// The theme setting/preview/resolution context. Holds the saved setting
// (which may be `auto`) and an optional preview; the setting in effect is
// the preview when one exists. Consumers only ever see a resolved concrete
// theme name — `auto` is resolved through the system-theme detector, seeded
// once at mount and re-seeded on the explicit apply/preview paths.
//
// Every resolved value — including the first, on mount — is pushed to the
// terminal background sync, so applying, previewing and cancelling all
// repaint the ground the palette really sits on.

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  DEFAULT_THEME_SETTING,
  getSystemThemeName,
  type SystemTheme,
} from '../../utils/systemTheme.js'
import { syncOasisBgToTheme } from '../../utils/cockpit/oasisBg.js'
import {
  REACHABLE_THEME_SETTINGS,
  THEME_SETTINGS,
  type ThemeName,
  type ThemeSetting,
} from '../../utils/theme.js'

type ThemeContextValue = {
  resolvedTheme: ThemeName
  themeSetting: ThemeSetting
  setThemeSetting: (setting: ThemeSetting) => void
  setPreviewTheme: (setting: ThemeSetting) => void
  savePreview: () => void
  cancelPreview: () => void
}

// The no-provider default (tests, tooling): the default appearance, both as
// the resolution and as the SETTING (never `auto`), and inert setters —
// reading outside a provider must not throw.
const DEFAULT_CONTEXT: ThemeContextValue = {
  resolvedTheme: DEFAULT_THEME_SETTING,
  themeSetting: DEFAULT_THEME_SETTING,
  setThemeSetting: () => {},
  setPreviewTheme: () => {},
  savePreview: () => {},
  cancelPreview: () => {},
}

const ThemeContext = createContext<ThemeContextValue>(DEFAULT_CONTEXT)

/** An explicitly passed initial state wins; a `MERCURY_THEME_PIN` value that
 *  is a member of the theme-setting list pins the setting for this process
 *  without touching the user's stored config; otherwise the stored global
 *  config theme is read (a fresh home carries the factory value, the
 *  default appearance) — COLLAPSED to the reachable vocabulary: a stored
 *  `dark` or `true-black` wins, and a name outside it (a dormant family,
 *  `auto`) resolves to the default appearance silently, no error, nothing
 *  rewritten — the full family vocabulary stays reachable through the pin
 *  and the explicit initial state, the capture/accessibility gate. */
function initialThemeSetting(initialState?: ThemeSetting): ThemeSetting {
  if (initialState !== undefined) return initialState
  const pin = flagEnv('MERCURY_THEME_PIN')
  if (pin !== undefined && (THEME_SETTINGS as readonly string[]).includes(pin)) {
    return pin
  }
  const stored = getGlobalConfig().theme
  return (REACHABLE_THEME_SETTINGS as readonly string[]).includes(stored)
    ? stored
    : DEFAULT_THEME_SETTING
}

/** The stored/pinned theme setting a fresh provider would seed from — the
 *  non-React read for surfaces outside the provider (the slash-menu row).
 *  Saved changes persist through onThemeSave, so this tracks them. */
export function currentStoredThemeSetting(): ThemeSetting {
  return initialThemeSetting()
}

export function ThemeProvider({
  children,
  initialState,
  onThemeSave,
}: {
  children?: React.ReactNode
  initialState?: ThemeSetting
  onThemeSave?: (setting: ThemeSetting) => void
}): React.ReactNode {
  const [savedSetting, setSavedSetting] = useState<ThemeSetting>(() =>
    initialThemeSetting(initialState),
  )
  const [previewSetting, setPreviewSettingState] = useState<
    ThemeSetting | undefined
  >(undefined)
  // Seeded once, and from the detector only when the effective setting
  // starts as `auto`; re-seeded on the explicit paths below.
  const [systemTheme, setSystemTheme] = useState<SystemTheme>(() =>
    (previewSetting ?? savedSetting) === 'auto' ? getSystemThemeName() : 'dark',
  )

  const effectiveSetting = previewSetting ?? savedSetting
  const resolvedTheme: ThemeName =
    effectiveSetting === 'auto' ? systemTheme : effectiveSetting

  // Every resolved value, the first one included, repaints the ground: dark
  // families take the product canvas, light families hand the ground back.
  useEffect(() => {
    syncOasisBgToTheme(resolvedTheme)
  }, [resolvedTheme])

  const value = useMemo<ThemeContextValue>(() => {
    const persist = (setting: ThemeSetting): void => {
      if (onThemeSave) {
        onThemeSave(setting)
        return
      }
      saveGlobalConfig(config => ({ ...config, theme: setting }))
    }
    return {
      resolvedTheme,
      themeSetting: savedSetting,
      setThemeSetting: (setting: ThemeSetting): void => {
        setSavedSetting(setting)
        setPreviewSettingState(undefined)
        persist(setting)
        // Re-seed immediately from the detector's cache so the palette does
        // not flash the wrong family while a terminal query round-trips.
        if (setting === 'auto') setSystemTheme(getSystemThemeName())
      },
      setPreviewTheme: (setting: ThemeSetting): void => {
        setPreviewSettingState(setting)
        if (setting === 'auto') setSystemTheme(getSystemThemeName())
      },
      savePreview: (): void => {
        if (previewSetting === undefined) return
        setSavedSetting(previewSetting)
        setPreviewSettingState(undefined)
        persist(previewSetting)
      },
      cancelPreview: (): void => {
        setPreviewSettingState(undefined)
      },
    }
  }, [resolvedTheme, savedSetting, previewSetting, onThemeSave])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** Positional tuple — consumers destructure `[theme, setTheme]`. */
export function useTheme(): readonly [
  ThemeName,
  (setting: ThemeSetting) => void,
] {
  const context = useContext(ThemeContext)
  return [context.resolvedTheme, context.setThemeSetting] as const
}

/** The raw stored setting, which may be `auto`. */
export function useThemeSetting(): ThemeSetting {
  return useContext(ThemeContext).themeSetting
}

export function usePreviewTheme(): {
  setPreviewTheme: (setting: ThemeSetting) => void
  savePreview: () => void
  cancelPreview: () => void
} {
  const context = useContext(ThemeContext)
  return {
    setPreviewTheme: context.setPreviewTheme,
    savePreview: context.savePreview,
    cancelPreview: context.cancelPreview,
  }
}
