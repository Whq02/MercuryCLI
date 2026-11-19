import React, {
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ModalContext } from '../../context/modalContext.js'
import { usePopupMarker } from '../../context/popupFormContext.js'
import { settingsPopupMarker } from '../../utils/cockpit/settingsPopup.js'
import { Box, Text, useInput } from '../../ink.js'
import { usePopupListPaging, PopupListViewport } from '../CustomSelect/popup-list.js'
import { escapeFromOutsidePress } from '../../ink/recessLayer.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import { getGlobalConfigCacheStamp, subscribeGlobalConfigCache } from '../../utils/config/globalConfig.js'
import { getEffectivePermissionMode } from '../../utils/config/derived.js'
import { saveGlobalConfig, type GlobalConfig } from '../../utils/config.js'
import { updateSettingsForSource, getInitialSettings } from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import {
  clearInstructionFileCaches,
} from '../../services/instructions/engine.js'
import {
  setSessionInstructionProfile,
  isInstructionProfile,
} from '../../services/instructions/profile.js'
import inkInstances from '../../ink/instances.js'
import { PERMISSION_MODES } from '../../utils/permissions/PermissionMode.js'
import { getEngineModel } from '../../utils/model/model.js'
import { useFocusedServedModel } from '../../hooks/useDisplayedSessionModel.js'
import { endEngineSession, resetShellEngineResolution } from '../../utils/shell/engineSession.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import { REACHABLE_THEME_SETTINGS } from '../../utils/theme.js'
import { useTheme, useThemeSetting } from '../design-system/ThemeProvider.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import { SearchBox } from '../SearchBox.js'
import { Select } from '../CustomSelect/select.js'
import { LanguagePicker } from '../LanguagePicker.js'
import { ExternalInstructionIncludesDialog } from '../ExternalInstructionIncludesDialog.js'
import type { ExternalInstructionInclude } from '../../services/instructions/engine.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { seatCeilingFactsAsync, type SeatCeilingFacts } from '../../services/switchboard/capacityCheck.js'
import { noteMotionSettingChanged } from '../../utils/cockpit/motionSetting.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { jevSessionFactsStamp, subscribeJevSessionFacts } from '../../services/jev/jevSessionFacts.js'
import { subagentDefaultsOf } from '../../utils/agentDefaults.js'
import { MercuryModelChoicePicker, modelChoiceLabel, modelChoiceRow } from '../../commands/model/mercuryModel.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { requestCommandDispatch } from '../../utils/cockpit/helmFocus.js'
import { LOCAL_SERVER_APPLY_MENU, LocalServerApplyDialog, useLocalServerConfig } from './LocalServer.js'
import { MediaConfigPicker, useMediaConfig } from './Media.js'
import { reloadExtensions, noteReloaded } from '../../extensions/boot.js'
import { extensionsStateFrom } from '../../hooks/useExtensions.js'
import { CONFIG_SEARCH_PLACEHOLDER, CONFIG_LIST_CHROME_ROWS, CONFIG_ROW_MARK, configPopupLine, configPopupFolder, configMoreRow, configWarningRows, configListWindow } from './config/configLayout.js'
import { type SubMenu, AGENT_INHERIT_ROW, type SettingsItem, THEME_LABELS, validated, type ConfigRowKit } from './config/configItems.js'
import { configRowApplicability } from './config/configRowFacts.js'
import { restoreConfigLeaf } from './config/configUndo.js'
import { useConfigWrites } from './config/useConfigWrites.js'
import { configCompactRows, configViewRows, configSessionRows } from './config/configRowsView.js'
import { configEngineRows } from './config/configRowsEngine.js'
import { configMemoryRows } from './config/configRowsMemory.js'
import { configModelRows, configApiKeyRows } from './config/configRowsModel.js'
import { configCrewRows } from './config/configRowsCrew.js'

export { CONFIG_POPUP_WIDTH, CONFIG_POPUP_ROWS, CONFIG_POPUP_HINT, CONFIG_SEARCH_PLACEHOLDER, CONFIG_LIST_CHROME_ROWS, CONFIG_ROW_MARK, configPopupLine, configPopupFolder, configMoreRow, configWarningRows, configListWindow, type ConfigListWindow } from './config/configLayout.js'
export { configRowApplicability, thinkingRowApplicability, mainLoopPointerText, localModelWindowRow, configProviderRows, type ConfigProviderRow } from './config/configRowFacts.js'

const LABEL_CELLS = 36
function valueOnOneLine(value: React.ReactNode): React.ReactNode {
  return isValidElement<{ wrap?: string }>(value) && value.type === Text && value.props.wrap === undefined ? cloneElement(value, { wrap: 'truncate-end' }) : value
}

export function Config({
  onClose,
  onLine,
  onOwnsEscape,
  context,
  width,
  contentHeight,
  compact = false,
}: {
  onClose: (result?: unknown) => void
  onLine?: (line: string) => void
  onOwnsEscape?: (owns: boolean) => void
  context: LocalJSXCommandContext
  width: number
  contentHeight: number
  compact?: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const setAppState = useSetAppState()
  const appState = useAppState((s: AppState) => s)
  const [, setThemeSetting] = useTheme()
  const themeSetting = useThemeSetting()
  const pastOpenEvent = useOpenEventGate()

  const { version, bump, config, merged, undoRef, dirtyRef, initialThinking, mountTheme, changesRef, recordToggle, recordSet, writeSource, writeFailed, writeGlobal } = useConfigWrites({ setAppState, themeSetting })

  const [subMenu, setSubMenu] = useState<SubMenu | null>(null)
  useEffect(() => {
    onOwnsEscape?.(true)
    return () => onOwnsEscape?.(false)
  }, [onOwnsEscape])
  const [thinkingWarning, setThinkingWarning] = useState(false)

  const conversationHasAssistantTurn = context.messages.some(
    message => message.type === 'assistant',
  )
  const thinkingOn = merged.engine?.reasoning !== false
  const permissions = merged.guardrails ?? {}
  const defaultMode = validated(
    PERMISSION_MODES,
    permissions.mode,
    'default',
  )
  const sessionMode = getEffectivePermissionMode(appState.toolPermissionContext.mode)
  const sessionModeDiffers = sessionMode.source !== 'session-choice' && sessionMode.mode !== defaultMode
  const modeOptions: ReadonlyArray<(typeof PERMISSION_MODES)[number]> = ['default', 'implement', 'apollo', 'flow', 'dontAsk']

  const boolValue = (on: boolean): React.ReactNode => (
    <Text color={on ? tokens.success : tokens.textSecondary}>
      {on ? 'on' : 'off'}
    </Text>
  )

  const servedModel = useFocusedServedModel()
  const mainRoute = declaredRouteOf(
    servedModel ?? appState.engineModelForSession ?? appState.engineModel ?? getEngineModel(),
  )
  const providerScoped = (item: SettingsItem, appliesTo: 'anthropic' | 'openrouter'): SettingsItem => {
    const applicability = configRowApplicability(appliesTo, mainRoute ?? 'unrecognised')
    if (applicability.applies) return item
    return {
      ...item,
      value: <Text color={tokens.textSecondary}>{applicability.naText}</Text>,
      warning: applicability.refuseNote,
      change: () => {},
    }
  }
  const rowKit: ConfigRowKit = { config, merged, tokens, boolValue, writeGlobal, writeSource, recordToggle, recordSet, bump }

  const media = useMediaConfig()
  const items: SettingsItem[] = []

  items.push(...configCompactRows(rowKit))
  const [seatFacts, setSeatFacts] = useState<SeatCeilingFacts | null>(null)
  const configStamp = useSyncExternalStore(subscribeGlobalConfigCache, getGlobalConfigCacheStamp, getGlobalConfigCacheStamp)
  useEffect(() => {
    let active = true
    void seatCeilingFactsAsync().then(facts => { if (active) setSeatFacts(facts) })
    return () => { active = false }
  }, [version, configStamp])
  const jevStamp = useSyncExternalStore(subscribeJevSessionFacts, jevSessionFactsStamp, jevSessionFactsStamp)
  const localServer = useLocalServerConfig(version)
  items.push(...configViewRows({ ...rowKit, seatFacts, setSeatFacts }))
  items.push(...configEngineRows({ ...rowKit, appState, setAppState, servedModel, thinkingOn, thinkingWarning, setThinkingWarning, conversationHasAssistantTurn, initialThinking, undoRef, providerScoped, sessionModeDiffers, defaultMode, sessionMode, modeOptions }))
  items.push(...configMemoryRows({ ...rowKit, themeSetting }))
  items.push(...configModelRows({ ...rowKit, appState, servedModel, mainRoute, configStamp, localServer }))

  items.push(...configSessionRows(rowKit))
  const externalIncludes = (
    appState as { externalIncludes?: ExternalInstructionInclude[] }
  ).externalIncludes
  if (Array.isArray(externalIncludes) && externalIncludes.length > 0) {
    items.push({
      id: 'externalIncludes',
      label: 'External-includes approval',
      kind: 'managed-enum',
      value: <Text>review</Text>,
      open: 'external-includes',
    })
  }
  items.push(...configApiKeyRows({ ...rowKit, providerScoped }))

  const agentDefaults = subagentDefaultsOf(config.agents)
  const writeAgents = (patch: Partial<NonNullable<GlobalConfig['agents']>>): void => {
    writeGlobal(c => ({ ...c, agents: { ...c.agents, ...patch } }))
  }
  items.push(...configCrewRows({ ...rowKit, agentDefaults, writeAgents }))

  items.push(...media.items)
  const [searchMode, setSearchMode] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [offset, setOffset] = useState(0)

  const filtered = useMemo(() => {
    if (query === '') return items
    const needle = query.toLowerCase()
    return items.filter(
      item =>
        item.id.toLowerCase().includes(needle) ||
        item.label.toLowerCase().includes(needle) ||
        (item.searchText ?? '').toLowerCase().includes(needle),
    )
  }, [query, version, appState, themeSetting, seatFacts, configStamp, servedModel, jevStamp, localServer.stamp, media.settings, media.catalogue, media.config, media.error])

  const line = configPopupLine(configPopupFolder(), items.length, items.filter(item => item.setByYou === true).length)
  useLayoutEffect(() => {
    onLine?.(line)
  }, [line, onLine])

  const searchRowUp = !compact || searchMode || query !== ''
  const listRows = Math.max(1, contentHeight - (compact ? (searchRowUp ? 1 : 0) : CONFIG_LIST_CHROME_ROWS))
  const windowFor = (index: number): number => {
    const warning = searchMode || compact ? undefined : filtered[index]?.warning
    if (warning === undefined) return listRows
    const beside = Math.max(1, listRows - configWarningRows(warning, width - 1))
    return filtered.length > beside ? beside : Math.max(1, listRows - configWarningRows(warning, width))
  }
  const win = configListWindow(selected, offset, filtered.length, windowFor(Math.max(0, Math.min(selected, filtered.length - 1))))
  useEffect(() => {
    if (win.sel !== selected) setSelected(win.sel)
    if (win.off !== offset) setOffset(win.off)
  }, [win.sel, win.off, selected, offset])
  usePopupMarker(compact && subMenu === null && filtered.length > 0 ? settingsPopupMarker(win.sel + 1, filtered.length) : null)

  const moveTo = (next: number): void => {
    const target = Math.max(0, Math.min(next, filtered.length - 1))
    const fixed = configListWindow(target, offset, filtered.length, windowFor(target))
    setSelected(fixed.sel)
    setOffset(fixed.off)
    setThinkingWarning(false)
  }
  usePopupListPaging(win.sel, filtered.length, windowFor(win.sel), moveTo, subMenu === null)

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
        if (undo.path[0] === 'mouseCapture') inkInstances.get(process.stdout)?.setMouseTrackingEnabled(undo.previous !== false)
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
    if (item.kind === 'managed-enum' && item.open !== undefined) setSubMenu(item.open)
    else item.change?.(1)
  }

  useInput(
    (input, key, event) => {
      if (subMenu !== null) return
      if (key.escape) {
        event.stopImmediatePropagation()
        escape()
        return
      }
      if (searchMode) {
        if (key.return || key.downArrow) {
          event.stopImmediatePropagation()
          setSearchMode(false)
          moveTo(0)
          return
        }
        if (key.backspace || key.delete) {
          event.stopImmediatePropagation()
          setQuery(q => q.slice(0, -1))
          return
        }
        if (
          input !== '' &&
          !key.ctrl &&
          !key.meta &&
          !key.tab &&
          input >= ' ' &&
          input.charCodeAt(0) !== 0x7f
        ) {
          event.stopImmediatePropagation()
          if (!pastOpenEvent()) return
          setQuery(q => q + input)
        }
        return
      }
      const item = filtered[selected]
      if (key.return) {
        event.stopImmediatePropagation()
        if (!pastOpenEvent()) return
        saveAndClose()
        return
      }
      if (key.upArrow) {
        event.stopImmediatePropagation()
        if (selected === 0) setSearchMode(true)
        else moveTo(selected - 1)
        return
      }
      if (key.downArrow) {
        event.stopImmediatePropagation()
        moveTo(selected + 1)
        return
      }
      if (key.leftArrow || key.rightArrow || key.tab) {
        if (item === undefined) return
        event.stopImmediatePropagation()
        if (!pastOpenEvent()) return
        const direction: 1 | -1 = key.leftArrow ? -1 : 1
        if (item.kind === 'managed-enum' && item.open !== undefined) {
          setSubMenu(item.open)
        } else {
          item.change?.(direction)
        }
        return
      }
      if (input === ' ') {
        event.stopImmediatePropagation()
        if (!pastOpenEvent()) return
        activate(selected)
        return
      }
      if (input === '/') {
        event.stopImmediatePropagation()
        if (!pastOpenEvent()) return
        setSearchMode(true)
        return
      }
      if (
        input !== '' &&
        !key.ctrl &&
        !key.meta &&
        input >= ' ' &&
        input !== ' ' &&
        input.charCodeAt(0) !== 0x7f
      ) {
        event.stopImmediatePropagation()
        if (!pastOpenEvent()) return
        setSearchMode(true)
        setQuery(input)
        return
      }
    },
    { isActive: subMenu === null },
  )

  if (subMenu === 'media-root' || subMenu === 'media-image' || subMenu === 'media-video') return <MediaConfigPicker key={subMenu} menu={subMenu} media={media} rows={contentHeight} width={width} onClose={() => setSubMenu(null)} />
  if (subMenu === 'theme') {
    return (
      <Select
        {...(compact ? { visibleOptionCount: Math.max(1, contentHeight) } : {})}
        options={REACHABLE_THEME_SETTINGS.map(setting => ({
          label: THEME_LABELS[setting] ?? setting,
          value: setting,
        }))}
        defaultValue={themeSetting}
        defaultFocusValue={themeSetting}
        onChange={value => {
          setThemeSetting(value)
          setSubMenu(null)
        }}
        onCancel={() => setSubMenu(null)}
      />
    )
  }
  if (subMenu === 'agent-model') {
    return (
      <ModalContext.Provider value={{ rows: contentHeight, columns: width, scrollRef: null }}>
      <MercuryModelChoicePicker
        leading={[AGENT_INHERIT_ROW]}
        current={agentDefaults.model === undefined || agentDefaults.model === AGENT_INHERIT_ROW.id ? AGENT_INHERIT_ROW.id : modelChoiceRow(agentDefaults.model)}
        onSelect={id => {
          const next = id === AGENT_INHERIT_ROW.id ? undefined : parseUserSpecifiedModel(id)
          writeAgents({ defaultModel: next })
          recordSet('agentsDefaultModel', `set the crewmate default model to ${next === undefined ? AGENT_INHERIT_ROW.name : modelChoiceLabel(next)}`)
          setSubMenu(null)
        }}
        onSignIn={signInFromDoor}
        onClose={() => setSubMenu(null)}
      />
      </ModalContext.Provider>
    )
  }
  if (subMenu === 'language') {
    return (
      <LanguagePicker
        initialLanguage={merged.voice?.language}
        onComplete={language => {
          if (writeSource('userSettings', { voice: { language: language } })) {
            recordSet('language', `set language to ${language ?? 'auto'}`)
          }
          setSubMenu(null)
        }}
        onCancel={() => setSubMenu(null)}
      />
    )
  }
  if (subMenu === 'external-includes') {
    return (
      <ExternalInstructionIncludesDialog
        isStandaloneDialog={false}
        externalIncludes={externalIncludes}
        onDone={() => {
          setSubMenu(null)
        }}
      />
    )
  }
  if (subMenu === LOCAL_SERVER_APPLY_MENU && localServer.plan !== null) {
    return (
      <LocalServerApplyDialog
        plan={localServer.plan}
        width={width}
        rows={contentHeight}
        onDone={() => setSubMenu(null)}
        onApplied={outcome => {
          if (outcome.outcome === 'applied') recordSet('localServer.apply', `applied the local server knobs (${outcome.restarted ? 'server restarted' : 'restart pending'})`)
        }}
      />
    )
  }

  const visible = filtered.slice(win.off, win.off + windowFor(win.sel))
  const band = width + 2 - (win.off > 0 || win.hiddenBelow > 0 ? 1 : 0)

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Box height={searchRowUp ? 1 : 0} overflow="hidden">
        <SearchBox
          query={query}
          isFocused={searchMode}
          isTerminalFocused={true}
          cursorOffset={query.length}
          placeholder={CONFIG_SEARCH_PLACEHOLDER}
          borderless={true}
        />
      </Box>
      <Box height={compact ? 0 : 1} />
      <PopupListViewport above={win.off} below={win.hiddenBelow} rows={visible.length}>
      {visible.map((item, index) => {
        const at = win.off + index
        const isSelected = !searchMode && at === win.sel
        return (
          <Box key={item.id} flexDirection="column" flexShrink={0}>
            <Box width={band} marginLeft={-1} marginRight={-1} flexShrink={0}>
              <InteractiveRow
                id={`config:row:${item.id}`}
                selected={isSelected}
                onSelect={() => {
                  setSearchMode(false)
                  moveTo(at)
                }}
                onActivate={() => activate(at)}
                width={band}
                height={1}
                flexShrink={0}
              >
                <Box width={1} flexShrink={0} />
                <Box width={LABEL_CELLS} flexShrink={0}>
                  <Text
                    bold={isSelected}
                    color={isSelected ? tokens.textPrimary : tokens.textSecondary}
                    wrap="truncate-end"
                  >
                    {isSelected ? `${CONFIG_ROW_MARK} ` : '  '}
                    {item.label}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
                  {valueOnOneLine(item.value)}
                </Box>
                <Box width={1} flexShrink={0} />
              </InteractiveRow>
            </Box>
            {isSelected && !compact && item.warning !== undefined ? (
              <Text color={tokens.warning}>{'  '}{item.warning}</Text>
            ) : null}
          </Box>
        )
      })}
      </PopupListViewport>
      {filtered.length === 0 ? (
        <Box height={1}>
          <Text color={tokens.textMuted}>no settings match “{query}”</Text>
        </Box>
      ) : null}
      <Box height={compact ? 0 : 1} overflow="hidden">
        <Text color={tokens.textMuted}>{configMoreRow(win.hiddenBelow)}</Text>
      </Box>
    </Box>
  )
}
