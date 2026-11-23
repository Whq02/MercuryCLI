import React from 'react'
import { useInput } from '../../themedRenderer.js'
import type { SubMenu, SettingsItem } from './configItems.js'

export function useConfigKeys({
  subMenu,
  escape,
  searchMode,
  setSearchMode,
  moveTo,
  setQuery,
  pastOpenEvent,
  filtered,
  selected,
  saveAndClose,
  activate,
}: {
  subMenu: SubMenu | null
  escape: () => void
  searchMode: boolean
  setSearchMode: (on: boolean) => void
  moveTo: (next: number) => void
  setQuery: React.Dispatch<React.SetStateAction<string>>
  pastOpenEvent: () => boolean
  filtered: SettingsItem[]
  selected: number
  saveAndClose: () => void
  activate: (index: number) => void
}): void {
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
          activate(selected)
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
}
