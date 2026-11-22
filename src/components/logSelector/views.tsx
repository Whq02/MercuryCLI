import { exitChordNoticeText } from '../PromptInput/ExitChordNotice.js'
import React, { useRef } from 'react'
import { Box, Text } from '../../ink.js'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { SessionListing } from '../../types/logs.js'
import { SearchBox } from '../SearchBox.js'
import { TagTabs } from '../TagTabs.js'
import TextInput from '../TextInput.js'
import { TreeSelect } from '../ui/TreeSelect.js'
import { Select } from '../CustomSelect/index.js'
import type { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import type { useSearchInput } from '../../hooks/useSearchInput.js'
import { packFooter } from '../mercury-ui/footerHint.js'
import type { MercuryThemeTokens } from '../../utils/mercuryTokens.js'
import { notBuilt } from '../../pi/holes.js'

function EmptyLogList({
  emptyReasons,
  isDisabled,
  onCancel,
}: {
  emptyReasons: string[]
  isDisabled: boolean
  onCancel: (() => void) | undefined
}): React.ReactNode {
  const overlayToken = useRegisterOverlay('select', Boolean(onCancel), { ownsPageKeys: false })
  const tokenRef = useRef(overlayToken)
  tokenRef.current = overlayToken
  useKeybindings(
    {
      'select:cancel': () => {
        const token = tokenRef.current
        if (token === null || !isTopOverlayNow(token)) return false
        onCancel?.()
      },
    },
    { context: 'Select', isActive: !isDisabled && Boolean(onCancel) },
  )
  return (
    <Text dimColor>
      no sessions match{emptyReasons.length > 0 ? ` — ${emptyReasons.join(' · ')}` : ''}
    </Text>
  )
}

export function logSelectorView(arg0: {
  grouped: { log: SessionListing; children: SessionListing[] }[]
  emptyReasons: string[]
  renaming: boolean
  searchMode: boolean
  rowLabel: (log: SessionListing, kind: 'header' | 'child' | 'flat', forkCount: number) => string
  describeLogFitted: (log: SessionListing, withProjectPath: boolean, width: number) => string
  showAllProjects: boolean
  labelWidth: number
  MIN_LABEL_WIDTH: number
  visibleCount: number
  forceExpanded: boolean
  expanded: ReadonlySet<string>
  setExpanded: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>
  setFocusedLog: React.Dispatch<React.SetStateAction<SessionListing | null>>
  onSelect: (log: SessionListing) => void
  onCancel: (() => void) | undefined
  setSearchMode: React.Dispatch<React.SetStateAction<boolean>>
  tokens: MercuryThemeTokens
  tagTabs: string[]
  selectedTag: string | null
  columns: number
  positionSuffix: string
  query: string
  search: ReturnType<typeof useSearchInput>
  filterParts: string[]
  inRename: boolean
  renameValue: string
  setRenameValue: React.Dispatch<React.SetStateAction<string>>
  submitRename: (title: string) => void
  renameCursor: number
  setRenameCursor: React.Dispatch<React.SetStateAction<number>>
  exitState: ReturnType<typeof useExitOnCtrlCDWithKeybindings>
  hints: string[]
  expandHint: string | null
}): React.ReactNode {
  return notBuilt('src/components/logSelector/views.tsx:46')
}
