import { featureReached } from '../../../platform/substrate/featureReached.js'
import React, { useRef } from 'react'
import { escapeFromOutsidePress } from '../../renderer/recessLayer.js'
import type { AppState } from '../../app-state/AppState.js'
import { saveGlobalConfig, type GlobalConfig } from '../../../platform/settings/config.js'
import { updateSettingsForSource, getInitialSettings } from '../../../platform/settings/settings.js'
import type { SettingsJson } from '../../../platform/settings/settingsSchema.js'
import { clearInstructionFileCaches } from '../../../sessions/instructions/instructionFiles.js'
import { setSessionInstructionProfile, isInstructionProfile } from '../../../sessions/instructions/profile.js'
import screenInstances from '../../renderer/instances.js'
import { endEngineSession, resetShellEngineResolution } from '../../../platform/shell/engineSession.js'
import type { ThemeSetting } from '../../theme/theme.js'
import { noteMotionSettingChanged } from '../../cockpit/motionSetting.js'
import { settingsChangeDetector } from '../../../platform/settings/changeDetector.js'
import { requestCommandDispatch } from '../../cockpit/helmFocus.js'
import type { useMediaConfig } from '../Media.js'
import { reloadExtensions, noteReloaded } from '../../../integrations/extensions/boot.js'
import { extensionsStateFrom } from '../../extensions/useExtensions.js'
import type { SubMenu, SettingsItem } from './configItems.js'
import { type ConfigUndo, restoreConfigLeaf } from './configUndo.js'

export function useConfigExits({
  changesRef,
  themeSetting,
  mountTheme,
  media,
  setAppState,
  onClose,
  writeFailed,
  setSubMenu,
  undoRef,
  bump,
  dirtyRef,
  setThinkingWarning,
  searchMode,
  query,
  setQuery,
  setSearchMode,
  filtered,
}: {
  changesRef: React.RefObject<Map<string, string>>
  themeSetting: ThemeSetting
  mountTheme: React.RefObject<ThemeSetting>
  media: ReturnType<typeof useMediaConfig>
  setAppState: (updater: (prevState: AppState) => AppState) => void
  onClose: (result?: unknown) => void
  writeFailed: (source: 'localSettings' | 'userSettings', error: Error) => void
  setSubMenu: (menu: SubMenu | null) => void
  undoRef: React.RefObject<ConfigUndo[]>
  bump: () => void
  dirtyRef: React.RefObject<boolean>
  setThinkingWarning: (on: boolean) => void
  searchMode: boolean
  query: string
  setQuery: React.Dispatch<React.SetStateAction<string>>
  setSearchMode: (on: boolean) => void
  filtered: SettingsItem[]
}) {
  const composeSummary = (): string | undefined => {
    const lines: string[] = [...changesRef.current.values()]
    if (themeSetting !== mountTheme.current) lines.push(`set theme to ${themeSetting}`)
    if (lines.length === 0) return undefined
    return lines.join('\n')
  }

  const mediaSaving = useRef(false)
  const saveAndClose = (): void => {
    if (mediaSaving.current) return
    mediaSaving.current = true
    void media.save().then(async reconnect => {
      if (reconnect) {
        const pending = reloadExtensions({ onServersChanged: () => setAppState(prev => ({ ...prev, mcp: { ...prev.mcp, extensionReconnectKey: prev.mcp.extensionReconnectKey + 1 } })) })
        noteReloaded(pending)
        const result = await pending
        setAppState(prev => ({ ...prev, extensions: extensionsStateFrom(result.set, false, null) }))
      }
      onClose(composeSummary())
    }).catch(error => writeFailed('userSettings', error instanceof Error ? error : new Error(String(error)))).finally(() => { mediaSaving.current = false })
  }

  const signInFromDoor = (): void => {
    setSubMenu(null)
    requestCommandDispatch('/logins')
    onClose([composeSummary(), 'Sign in first — /logins opens; the door lists that family once a credential connects'].filter(Boolean).join('\n'))
  }

  const revert = (): boolean => {
    media.revert()
    while (undoRef.current.length > 0) {
      const undo = undoRef.current.at(-1)!
      if (undo.source === 'global') {
        saveGlobalConfig(current => restoreConfigLeaf(current, undo.path, undo.previous) as GlobalConfig)
        if (undo.path[0] === 'motion') noteMotionSettingChanged()
        if (undo.path[0] === 'mouseCapture') screenInstances.get(process.stdout)?.setMouseTrackingEnabled(undo.previous !== false)
      } else if (undo.source === 'app') {
        setAppState(prev => ({ ...prev, verbose: undo.previous as boolean }))
      } else {
        const partial = undo.path.reduceRight<unknown>((value, key) => ({ [key]: value }), undo.previous) as Partial<SettingsJson>
        const { error } = updateSettingsForSource(undo.source, partial)
        if (error !== null) {
          writeFailed(undo.source, error)
          bump()
          return false
        }
        if (undo.path[0] === 'view' && undo.path[1] === 'zen') settingsChangeDetector.notifyChange(undo.source)
        if (undo.path[0] === 'briefs' && undo.path[1] === 'profile') {
          const restoredProfile = getInitialSettings().briefs?.profile
          setSessionInstructionProfile(isInstructionProfile(restoredProfile) ? restoredProfile : null)
          clearInstructionFileCaches()
        }
        if (undo.path[0] === 'shell' && undo.path[1] === 'engine') {
          resetShellEngineResolution()
          void endEngineSession()
        }
      }
      undoRef.current.pop()
    }
    changesRef.current.clear()
    dirtyRef.current = false
    setThinkingWarning(false)
    bump()
    return true
  }

  const escape = (): void => {
    if (mediaSaving.current) return
    if (escapeFromOutsidePress()) {
      if ((dirtyRef.current || media.dirty) && !revert()) return
      onClose(undefined)
      return
    }
    if (searchMode && query !== '') {
      setQuery('')
      return
    }
    if (searchMode) setSearchMode(false)
    if ((dirtyRef.current || media.dirty)) {
      revert()
      return
    }
    onClose(undefined)
  }

  const activate = (index: number): void => {
    const item = filtered[index]
    if (item === undefined) return
    if (item.kind === 'managed-enum' && item.open !== undefined) {
      if (item.open === 'media-root' || item.open === 'media-image' || item.open === 'media-video') featureReached('screen', 'MediaConfigPicker')
      setSubMenu(item.open)
    } else item.change?.(1)
  }
  return { saveAndClose, signInFromDoor, escape, activate }
}
