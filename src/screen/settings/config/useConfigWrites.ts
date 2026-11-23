import { useRef, useState } from 'react'
import { enqueueNotification } from '../../notifications/notifications.js'
import type { AppState } from '../../app-state/AppState.js'
import { getGlobalConfig, saveGlobalConfig, type GlobalConfig } from '../../../platform/settings/config.js'
import { updateSettingsForSource, getInitialSettings } from '../../../platform/settings/settings.js'
import type { SettingsJson } from '../../../platform/settings/settingsSchema.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import type { ThemeSetting } from '../../theme/theme.js'
import { type ConfigUndo, configUndoLeaves } from './configUndo.js'

export function useConfigWrites({
  setAppState,
  themeSetting,
}: {
  setAppState: (updater: (prevState: AppState) => AppState) => void
  themeSetting: ThemeSetting
}) {
  const [version, setVersion] = useState(0)
  const bump = (): void => setVersion(v => v + 1)
  void version
  const config = getGlobalConfig()
  const merged = getInitialSettings() as SettingsJson

  const undoRef = useRef<ConfigUndo[]>([])
  const dirtyRef = useRef(false)
  const initialThinking = useRef(merged.engine?.reasoning !== false)
  const mountTheme = useRef(themeSetting)

  const changesRef = useRef(new Map<string, string>())
  const recordToggle = (key: string, text: string): void => {
    dirtyRef.current = true
    if (changesRef.current.has(key)) changesRef.current.delete(key)
    else changesRef.current.set(key, text)
  }
  const recordSet = (key: string, text: string): void => {
    dirtyRef.current = true
    changesRef.current.delete(key)
    changesRef.current.set(key, text)
  }

  const writeSource = (
    source: 'localSettings' | 'userSettings',
    partial: Partial<SettingsJson>,
  ): boolean => {
    let undo: ConfigUndo[] = []
    const { error } = updateSettingsForSource(source, raw => {
      undo = configUndoLeaves(source, raw, partial, [], true)
      return partial
    })
    if (error !== null) {
      writeFailed(source, error)
      return false
    }
    undoRef.current.push(...undo)
    dirtyRef.current = true
    return true
  }
  const writeFailed = (source: 'localSettings' | 'userSettings', error: Error): void => {
    logForDebugging(`settings write failed (${source}): ${error.message}`)
    enqueueNotification(setAppState, {
      key: 'config-write-failed',
      text: `that change did not save — ${source === 'localSettings' ? 'project-local' : 'user'} settings write failed: ${error.message}`,
      priority: 'high',
      color: 'error',
      timeoutMs: 15_000,
    })
  }
  const writeGlobal = (mutate: (config: GlobalConfig) => GlobalConfig): void => {
    let undo: ConfigUndo[] = []
    saveGlobalConfig(current => {
      const next = mutate(current)
      undo = configUndoLeaves('global', current, next)
      return next
    })
    undoRef.current.push(...undo)
    dirtyRef.current = true
    bump()
  }
  return { version, bump, config, merged, undoRef, dirtyRef, initialThinking, mountTheme, changesRef, recordToggle, recordSet, writeSource, writeFailed, writeGlobal }
}
