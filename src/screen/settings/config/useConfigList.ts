import { useMemo, useState } from 'react'
import { useLayoutPublish } from '../../effects/effects.js'
import { usePopupMarker } from '../../overlays/popupFormContext.js'
import { settingsPopupMarker } from '../../cockpit/settingsPopup.js'
import { usePopupListPaging } from '../../select/popup-list.js'
import type { AppState } from '../../app-state/AppState.js'
import type { ThemeSetting } from '../../theme/theme.js'
import type { SeatCeilingFacts } from '../../../daemon/switchboard-capacity/capacityCheck.js'
import type { LocalServerConfigState } from '../LocalServer.js'
import type { useMediaConfig } from '../Media.js'
import { CONFIG_LIST_CHROME_ROWS, configPopupLine, configPopupFolder, configWarningRows, configListWindow } from './configLayout.js'
import type { SubMenu, SettingsItem } from './configItems.js'

export function useConfigList({
  items,
  version,
  appState,
  themeSetting,
  seatFacts,
  configStamp,
  servedModel,
  jevStamp,
  localServer,
  media,
  onLine,
  compact,
  contentHeight,
  width,
  subMenu,
  setThinkingWarning,
}: {
  items: SettingsItem[]
  version: number
  appState: AppState
  themeSetting: ThemeSetting
  seatFacts: SeatCeilingFacts | null
  configStamp: number
  servedModel: string | null
  jevStamp: string
  localServer: LocalServerConfigState
  media: ReturnType<typeof useMediaConfig>
  onLine: ((line: string) => void) | undefined
  compact: boolean
  contentHeight: number
  width: number
  subMenu: SubMenu | null
  setThinkingWarning: (on: boolean) => void
}) {
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
  useLayoutPublish(() => {
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
  if (win.sel !== selected) setSelected(win.sel)
  if (win.off !== offset) setOffset(win.off)
  usePopupMarker(compact && subMenu === null && filtered.length > 0 ? settingsPopupMarker(win.sel + 1, filtered.length) : null)

  const moveTo = (next: number): void => {
    const target = Math.max(0, Math.min(next, filtered.length - 1))
    const fixed = configListWindow(target, offset, filtered.length, windowFor(target))
    setSelected(fixed.sel)
    setOffset(fixed.off)
    setThinkingWarning(false)
  }
  usePopupListPaging(win.sel, filtered.length, windowFor(win.sel), moveTo, subMenu === null)
  return { searchMode, setSearchMode, query, setQuery, selected, filtered, searchRowUp, windowFor, win, moveTo }
}
