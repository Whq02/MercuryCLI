import type { AppState } from '../app-state/AppState.js'
import type { AppStateStore } from '../app-state/AppStateStore.js'
import { anyModalOverlayActive, topOverlay } from '../overlays/overlayStack.js'
import { currentSurfaceRoute } from '../routes/surfaceRoute.js'
import type { SuggestionsState } from './typeahead/useTypeahead.js'
import type { Key } from '../renderer/events/input-event.js'
import type { useOptionalKeybindingContext } from '../keys/KeybindingContext.js'
import { getGlobalConfig, saveGlobalConfig } from '../../platform/settings/config.js'
import { isManageableTask } from '../tasks/taskStatus.js'
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js'
import type { useComposerHistory } from './useComposerHistory.js'

export function composerRouteInput({
  compactWork,
  keyboardOwnedByOverlay,
  isSearchingHistory,
  helmOnPrompt,
  keybindings,
  isCompact,
  inputAvailable,
  summaryVisible,
}: {
  compactWork: CompactWorkControls | undefined
  keyboardOwnedByOverlay: boolean
  isSearchingHistory: boolean
  helmOnPrompt: boolean
  keybindings: ReturnType<typeof useOptionalKeybindingContext>
  isCompact: boolean
  inputAvailable: boolean
  summaryVisible: boolean
}) {
  return compactWork === undefined ? undefined : (raw: string, key: Key, event: import('../renderer/events/input-event.js').InputEvent, pastePending: boolean) => {
    if (currentSurfaceRoute().kind !== 'repl') return 'yield' as const
    const focus = compactWork.read()
    if (anyModalOverlayActive() && !(focus === 'composer' && topOverlay()?.id === 'compact-work')) return 'yield' as const
    if (keyboardOwnedByOverlay || isSearchingHistory || !helmOnPrompt) return 'yield' as const
    if (focus === 'detail') {
      if (key.escape) compactWork.set('composer')
      return 'consume' as const
    }
    if (pastePending) {
      const resolved = keybindings?.resolve(raw, key, ['Chat', 'Global'])
      return resolved?.type === 'match' && resolved.action === 'app:toggleTasks' ? 'consume' as const : 'edit-and-consume' as const
    }
    const resolved = keybindings?.resolve(raw, key, ['Footer', 'Chat', 'Global'])
    if (isCompact && resolved?.type === 'match' && resolved.action === 'app:toggleTasks') {
      compactWork.toggleSummary()
      return 'consume' as const
    }
    if (focus !== 'summary') return inputAvailable ? 'edit' as const : 'yield' as const
    if (!summaryVisible) { compactWork.set('composer'); return 'edit' as const }
    if (key.isPasted || (raw !== '' && !key.ctrl && !key.meta && !key.escape && !key.return && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.pageUp && !key.pageDown && !key.backspace && !key.delete)) {
      compactWork.set('composer')
      return 'edit-and-consume' as const
    }
    if (key.escape) { compactWork.set('composer'); return 'consume' as const }
    if (key.return && !key.shift && !key.ctrl && !key.meta) { compactWork.set('detail'); return 'consume' as const }
    if (key.pageUp || key.pageDown || key.wheelUp || key.wheelDown) return 'yield' as const
    if (key.ctrl && (raw === 'c' || raw === 'd')) { compactWork.set('composer'); return 'edit' as const }
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) { compactWork.set('composer'); return 'consume' as const }
    void event
    return 'consume' as const
  }
}

export function composerHistoryDown({
  historyNavAllowed,
  history,
  footerSelection,
  suggestionsMirrorRef,
  isCompact,
  compactWork,
  canFocusSummary,
  appStateStore,
  setAppState,
}: {
  historyNavAllowed: (edge: 'first' | 'last') => boolean
  history: ReturnType<typeof useComposerHistory>['history']
  footerSelection: AppState['footerSelection']
  suggestionsMirrorRef: { current: SuggestionsState }
  isCompact: boolean
  compactWork: CompactWorkControls | undefined
  canFocusSummary: () => boolean
  appStateStore: AppStateStore
  setAppState: (f: (prev: AppState) => AppState) => void
}) {
  return () => {
    if (!historyNavAllowed('last')) return
    if (history.historyIndex === 0) {
      if (footerSelection === null && suggestionsMirrorRef.current.suggestions.length === 0) {
        if (isCompact) {
          if (compactWork !== undefined && canFocusSummary()) compactWork.set('summary')
          return
        }
        const manageable = Object.values(appStateStore.getState().tasks).filter(isManageableTask)
        if (manageable.length > 0) {
          setAppState(prev => ({ ...prev, footerSelection: 'tasks' as const }))
          if (getGlobalConfig().hasSeenTasksHint !== true) {
            saveGlobalConfig(config => ({ ...config, hasSeenTasksHint: true }))
          }
        }
      }
      return
    }
    history.onHistoryDown()
  }
}
