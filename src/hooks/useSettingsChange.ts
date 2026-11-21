
import { useRef } from 'react'
import { useClaim } from './effects.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import type { SettingSource } from '../utils/settings/constants.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'

export function useSettingsChange(
  onChange: (source: SettingSource, settings: SettingsJson) => void,
): void {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useClaim(() => {
    return settingsChangeDetector.subscribe(source => {
      onChangeRef.current(source, getInitialSettings())
    })
  }, [])
}
