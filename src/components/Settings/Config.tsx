import React, { useEffect, useState, useSyncExternalStore } from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import '../../context/notifications.js'
import '../../context/modalContext.js'
import '../../context/popupFormContext.js'
import '../../utils/cockpit/settingsPopup.js'
import { Text } from '../../ink.js'
import '../CustomSelect/popup-list.js'
import '../../ink/recessLayer.js'
import '../../ink/wrap-text.js'
import '../../hooks/useFocusedWorkspaceCwd.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import { getGlobalConfigCacheStamp, subscribeGlobalConfigCache } from '../../utils/config/globalConfig.js'
import { getEffectivePermissionMode } from '../../utils/config/derived.js'
import type { GlobalConfig } from '../../utils/config.js'
import '../../utils/permissions/permissionSetup.js'
import '../../utils/config.js'
import '../../utils/settings/settings.js'
import '../../services/search/searchSetting.js'
import '../../mneme/journalSetting.js'
import '../../mneme/mnemeFrontPage.js'
import '../../mneme/mnemeMaintenance.js'
import '../../mneme/entryKnapsack.js'
import '../../mneme/mnemeUsage.js'
import '../../mneme/embedModels.js'
import '../../utils/format.js'
import '../../services/instructions/engine.js'
import '../../services/instructions/profile.js'
import '../../utils/fullscreen.js'
import '../../ink/instances.js'
import '../../context/surfaceRoute.js'
import '../../utils/debug.js'
import { PERMISSION_MODES } from '../../utils/permissions/PermissionMode.js'
import { getEngineModel } from '../../utils/model/model.js'
import '../../services/providers/zai/glmPins.js'
import '../../utils/model/capabilities.js'
import { useFocusedServedModel } from '../../hooks/useDisplayedSessionModel.js'
import '../../services/providers/patience.js'
import '../../utils/shell/engineSession.js'
import '../../utils/shell/windowsShellRoad.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import '../../services/providers/providerUsage.js'
import '../../services/providers/providerIdentityLine.js'
import '../../utils/theme.js'
import '../../utils/systemTheme.js'
import { useTheme, useThemeSetting } from '../design-system/ThemeProvider.js'
import '../mercury-ui/glyphs.js'
import '../mercury-ui/InteractiveRow.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import type { ExternalInstructionInclude } from '../../services/instructions/engine.js'
import '../SearchBox.js'
import '../CustomSelect/select.js'
import '../LanguagePicker.js'
import '../ExternalInstructionIncludesDialog.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import '../../services/engine-connector/focusedConnector.js'
import { seatCeilingFactsAsync, type SeatCeilingFacts } from '../../services/switchboard/capacityCheck.js'
import '../../utils/cockpit/motionSetting.js'
import '../../utils/settings/changeDetector.js'
import { jevSessionFactsStamp, subscribeJevSessionFacts } from '../../services/jev/jevSessionFacts.js'
import '../../services/jev/jevSetting.js'
import '../../services/switchboard/backgroundLaunch.js'
import '../../services/jev/jevStatus.js'
import { subagentDefaultsOf } from '../../utils/agentDefaults.js'
import '../../constants/subagentDoctrine.js'
import '../../utils/effort.js'
import '../../commands/model/mercuryModel.js'
import '../../utils/cockpit/helmFocus.js'
import '../../services/providers/local/localAccounts.js'
import '../../commands/localsetup/words.js'
import '../../services/providers/local/localCatalogue.js'
import '../../services/providers/local/localWindow.js'
import '../../services/providers/local/tensorfoldHelper.js'
import { useLocalServerConfig } from './LocalServer.js'
import './Advisor.js'
import '../../services/crewBoard/seam.js'
import { useMediaConfig } from './Media.js'
import '../../extensions/boot.js'
import '../../hooks/useExtensions.js'
import '../../services/advisor/advisorSettings.js'
import '../../utils/isRecord.js'
import { type SubMenu, type SettingsItem, validated, type ConfigRowKit } from './config/configItems.js'
import { configRowApplicability } from './config/configRowFacts.js'
import { useConfigWrites } from './config/useConfigWrites.js'
import { configCompactRows, configViewRows, configSessionRows } from './config/configRowsView.js'
import { configEngineRows } from './config/configRowsEngine.js'
import { configMemoryRows } from './config/configRowsMemory.js'
import { configModelRows, configApiKeyRows } from './config/configRowsModel.js'
import { configCrewRows } from './config/configRowsCrew.js'
import { useConfigList } from './config/useConfigList.js'
import { useConfigExits } from './config/useConfigExits.js'
import { useConfigKeys } from './config/useConfigKeys.js'
import { configSubMenuView, configListView } from './config/ConfigViews.js'

export { CONFIG_POPUP_WIDTH, CONFIG_POPUP_ROWS, CONFIG_POPUP_HINT, CONFIG_SEARCH_PLACEHOLDER, CONFIG_LIST_CHROME_ROWS, CONFIG_ROW_MARK, configPopupLine, configPopupFolder, configMoreRow, configWarningRows, configListWindow, type ConfigListWindow } from './config/configLayout.js'
export { configRowApplicability, thinkingRowApplicability, mainLoopPointerText, localModelWindowRow, configProviderRows, type ConfigProviderRow } from './config/configRowFacts.js'

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
  const { searchMode, setSearchMode, query, setQuery, selected, filtered, searchRowUp, windowFor, win, moveTo } = useConfigList({ items, version, appState, themeSetting, seatFacts, configStamp, servedModel, jevStamp, localServer, media, onLine, compact, contentHeight, width, subMenu, setThinkingWarning })

  const { saveAndClose, signInFromDoor, escape, activate } = useConfigExits({ changesRef, themeSetting, mountTheme, media, setAppState, onClose, writeFailed, setSubMenu, undoRef, bump, dirtyRef, setThinkingWarning, searchMode, query, setQuery, setSearchMode, filtered })

  useConfigKeys({ subMenu, escape, searchMode, setSearchMode, moveTo, setQuery, pastOpenEvent, filtered, selected, saveAndClose, setSubMenu, activate })

  const subMenuView = configSubMenuView({ subMenu, media, contentHeight, width, compact, themeSetting, setThemeSetting, setSubMenu, agentDefaults, writeAgents, recordSet, signInFromDoor, merged, writeSource, externalIncludes, localServer })
  if (subMenuView !== null) return subMenuView

  return configListView({ filtered, win, windowFor, width, searchRowUp, query, searchMode, compact, tokens, setSearchMode, moveTo, activate })
}
