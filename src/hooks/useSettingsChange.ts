
import { useEffect, useRef } from 'react'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import type { SettingSource } from '../utils/settings/constants.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'

export function useSettingsChange(
  onChange: (source: SettingSource, settings: SettingsJson) => void,
): void {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useEffect(() => {
    return settingsChangeDetector.subscribe(source => {
      onChangeRef.current(source, getInitialSettings())
    })
  }, [])
}
