import React, { useState, useSyncExternalStore } from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { Text } from '../../ink.js'
import { useAppState, useSetAppState, type AppState } from '../../state/AppState.js'
import { getGlobalConfigCacheStamp, subscribeGlobalConfigCache } from '../../utils/config/globalConfig.js'
import { getEffectivePermissionMode } from '../../utils/config/derived.js'
import type { GlobalConfig } from '../../utils/config.js'
import { PERMISSION_MODES } from '../../utils/permissions/PermissionMode.js'
import { getEngineModel } from '../../services/model/model.js'
import { useFocusedServedModel } from '../../hooks/useDisplayedSessionModel.js'
import { useClaim, useLoad } from '../../hooks/effects.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import { useTheme, useThemeSetting } from '../design-system/ThemeProvider.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import type { ExternalInstructionInclude } from '../../services/instructions/engine.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { seatCeilingFactsAsync, type SeatCeilingFacts } from '../../utils/switchboard/capacityCheck.js'
import { jevSessionFactsStamp, subscribeJevSessionFacts } from '../../services/jev/jevSessionFacts.js'
import { subagentDefaultsOf } from '../../utils/agentDefaults.js'
import { useLocalServerConfig } from './LocalServer.js'
import { useMediaConfig } from './Media.js'
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
import { notBuilt } from '../../pi/holes.js'

export { CONFIG_POPUP_WIDTH, CONFIG_POPUP_ROWS, CONFIG_POPUP_HINT, CONFIG_SEARCH_PLACEHOLDER, CONFIG_LIST_CHROME_ROWS, CONFIG_ROW_MARK, configPopupLine, configPopupFolder, configMoreRow, configWarningRows, configListWindow, type ConfigListWindow } from './config/configLayout.js'
export { configRowApplicability, thinkingRowApplicability, mainLoopPointerText, localModelWindowRow, configProviderRows, type ConfigProviderRow } from './config/configRowFacts.js'

export function Config(arg0: {
  onClose: (result?: unknown) => void
  onLine?: (line: string) => void
  onOwnsEscape?: (owns: boolean) => void
  context: LocalJSXCommandContext
  width: number
  contentHeight: number
  compact?: boolean
}): React.ReactNode {
  return notBuilt('src/components/Settings/Config.tsx:38')
}
