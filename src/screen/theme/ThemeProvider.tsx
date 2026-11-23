import React, {
  createContext,
  useContext,
  useMemo,
  useState,
} from 'react'
import { useLayoutClaim, usePublish } from '../effects/effects.js'
import { setMonochromeTheme } from '../renderer/colorize.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getGlobalConfig, saveGlobalConfig } from '../../platform/settings/config.js'
import { DEFAULT_THEME_SETTING, resolveThemeSetting } from './systemTheme.js'
import { syncOasisBgToTheme } from '../cockpit/oasisBg.js'
import {
  isMonochromeTheme,
  REACHABLE_THEME_SETTINGS,
  THEME_SETTINGS,
  type ThemeName,
  type ThemeSetting,
} from './theme.js'
import { isOneOf } from '../../platform/primitives/isOneOf.js'

type ThemeContextValue = {
  resolvedTheme: ThemeName
  themeSetting: ThemeSetting
  setThemeSetting: (setting: ThemeSetting) => void
  setPreviewTheme: (setting: ThemeSetting) => void
  savePreview: () => void
  cancelPreview: () => void
}

const DEFAULT_CONTEXT: ThemeContextValue = {
  resolvedTheme: DEFAULT_THEME_SETTING,
  themeSetting: DEFAULT_THEME_SETTING,
  setThemeSetting: () => {},
  setPreviewTheme: () => {},
  savePreview: () => {},
  cancelPreview: () => {},
}

const ThemeContext = createContext<ThemeContextValue>(DEFAULT_CONTEXT)

function initialThemeSetting(initialState?: ThemeSetting): ThemeSetting {
  if (initialState !== undefined) return initialState
  const pin = flagEnv('MERCURY_THEME_PIN')
  if (pin !== undefined && isOneOf(THEME_SETTINGS, pin)) {
    return pin
  }
  const stored = getGlobalConfig().theme
  return isOneOf(REACHABLE_THEME_SETTINGS, stored)
    ? stored
    : DEFAULT_THEME_SETTING
}

export function currentStoredThemeSetting(): ThemeSetting {
  return initialThemeSetting()
}

export function ThemeProvider({ children, initialState, onThemeSave }: {
  children?: React.ReactNode
  initialState?: ThemeSetting
  onThemeSave?: (setting: ThemeSetting) => void
}): React.ReactNode {
  const ownsMonochrome = useContext(ThemeContext) === DEFAULT_CONTEXT
  const [themeSetting, setSaved] = useState(() => initialThemeSetting(initialState))
  const [preview, setPreview] = useState<ThemeSetting | null>(null)
  const resolvedTheme = resolveThemeSetting(preview ?? themeSetting)
  if (ownsMonochrome) setMonochromeTheme(isMonochromeTheme(resolvedTheme))
  useLayoutClaim(() => {
    if (ownsMonochrome) return () => { setMonochromeTheme(false) }
  }, [ownsMonochrome])
  usePublish(() => { syncOasisBgToTheme(resolvedTheme) }, [resolvedTheme])
  const value = useMemo<ThemeContextValue>(() => {
    const setThemeSetting = (setting: ThemeSetting): void => {
      setSaved(setting)
      setPreview(null)
      if (onThemeSave) onThemeSave(setting)
      else saveGlobalConfig(config => ({ ...config, theme: setting }))
    }
    return {
      resolvedTheme,
      themeSetting,
      setThemeSetting,
      setPreviewTheme: setPreview,
      savePreview: () => { if (preview !== null) setThemeSetting(preview) },
      cancelPreview: () => setPreview(null),
    }
  }, [resolvedTheme, themeSetting, preview, onThemeSave])
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
  const { setPreviewTheme, savePreview, cancelPreview } = useContext(ThemeContext)
  return { setPreviewTheme, savePreview, cancelPreview }
}
