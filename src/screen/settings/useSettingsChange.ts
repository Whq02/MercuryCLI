
import { useRef } from 'react'
import { useClaim } from '../effects/effects.js'
import { settingsChangeDetector } from '../../platform/settings/changeDetector.js'
import type { SettingSource } from '../../platform/settings/settingSources.js'
import { getInitialSettings } from '../../platform/settings/settings.js'
import type { SettingsJson } from '../../platform/settings/settingsSchema.js'

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
