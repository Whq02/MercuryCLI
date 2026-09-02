
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

const DEFAULT_CONTEXT: ThemeContextValue = {
  resolvedTheme: 'dark',
  themeSetting: 'dark',
  setThemeSetting: () => {},
  setPreviewTheme: () => {},
  savePreview: () => {},
  cancelPreview: () => {},
}

const ThemeContext = createContext<ThemeContextValue>(DEFAULT_CONTEXT)

function initialThemeSetting(initialState?: ThemeSetting): ThemeSetting {
  if (initialState !== undefined) return initialState
  const pin = flagEnv('MERCURY_THEME_PIN')
  if (pin !== undefined && (THEME_SETTINGS as readonly string[]).includes(pin)) {
    return pin
  }
  const stored = getGlobalConfig().theme
  return (REACHABLE_THEME_SETTINGS as readonly string[]).includes(stored)
    ? stored
    : 'dark'
}

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
  const [systemTheme, setSystemTheme] = useState<SystemTheme>(() =>
    (previewSetting ?? savedSetting) === 'auto' ? getSystemThemeName() : 'dark',
  )

  const effectiveSetting = previewSetting ?? savedSetting
  const resolvedTheme: ThemeName =
    effectiveSetting === 'auto' ? systemTheme : effectiveSetting

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

export function useTheme(): readonly [
  ThemeName,
  (setting: ThemeSetting) => void,
] {
  const context = useContext(ThemeContext)
  return [context.resolvedTheme, context.setThemeSetting] as const
}

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
