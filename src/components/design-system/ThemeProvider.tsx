import React, {
  createContext,
  useContext,
  useMemo,
  useState,
} from 'react'
import { useLayoutClaim, usePublish } from '../../hooks/effects.js'
import { setMonochromeTheme } from '../../ink/colorize.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { DEFAULT_THEME_SETTING, resolveThemeSetting } from '../../utils/systemTheme.js'
import { syncOasisBgToTheme } from '../../utils/cockpit/oasisBg.js'
import {
  isMonochromeTheme,
  REACHABLE_THEME_SETTINGS,
  THEME_SETTINGS,
  type ThemeName,
  type ThemeSetting,
} from '../../utils/theme.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

type ThemeContextValue = Unbuilt

const DEFAULT_CONTEXT: ThemeContextValue = unbuilt('src/components/design-system/ThemeProvider.tsx:31')

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
    : DEFAULT_THEME_SETTING
}

export function currentStoredThemeSetting(): ThemeSetting {
  return initialThemeSetting()
}

export function ThemeProvider(arg0: {
  children?: React.ReactNode
  initialState?: ThemeSetting
  onThemeSave?: (setting: ThemeSetting) => void
}): React.ReactNode {
  return notBuilt('src/components/design-system/ThemeProvider.tsx:58')
}

export function useTheme(): readonly [
  ThemeName,
  (setting: ThemeSetting) => void,
] {
  const context = useContext(ThemeContext)
  return [context.resolvedTheme, context.setThemeSetting] as const
}

export function useThemeSetting(): ThemeSetting {
  return notBuilt('src/components/design-system/ThemeProvider.tsx:132')
}

export function usePreviewTheme(): {
  setPreviewTheme: (setting: ThemeSetting) => void
  savePreview: () => void
  cancelPreview: () => void
} {
  return notBuilt('src/components/design-system/ThemeProvider.tsx:136')
}
