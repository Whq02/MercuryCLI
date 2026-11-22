import { useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useClaim, useLoad } from './effects.js'
import type { Command } from '../commands.js'
import type {
  SuggestionItem as Suggestion,
  SuggestionType,
} from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { getSelectedSuggestion } from '../components/PromptInput/suggestionSelectionStore.js'
import { useNotifications } from '../context/notifications.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { useIsModalOverlayActive, useRegisterOverlay } from '../context/overlayContext.js'
import { useInput } from '../ink.js'
import type { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppStateStore } from '../state/AppState.js'
import type {
  InlineGhostText,
  PromptInputMode,
} from '../types/textInputTypes.js'
import {
  findChannelTargetQuery,
} from '../utils/suggestions/commandSuggestions.js'
import { getFocusedSessionConnector, hasFocusedSession, subscribeThroughFocused } from '../services/engine-connector/focusedConnector.js'
import {
  onIndexBuildComplete,
  startBackgroundCacheRefresh,
} from '../hooks/fileSuggestions.js'
import type { AgentDefinition } from '../types/agent.js'
import { disarmTypeaheadTimer } from './typeahead/timers.js'
import { ladderChannelTarget, ladderClearStale, ladderCommands, ladderMentions, ladderPaths, type LadderContext } from './typeahead/ladder.js'
import type { SuggestionsState } from './typeahead/state.js'
import { acceptAgent, acceptChannelTarget, acceptCommand, acceptGhost, acceptCustomTitle, acceptDirectory, acceptFile, acceptShell, acceptSlackChannel, acceptWithoutList, type AcceptContext } from './typeahead/accept.js'
import { acceptPromptSuggestionOf, handleTypeaheadKey, routeTypeaheadInput, typeaheadKeybindings } from './typeahead/keys.js'
import { promptGhostOf, publishSuggestionsOf, rerunLadderOf, runUnifiedFetchOf } from './typeahead/fetch.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'
const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const subscribeFocusedWork = subscribeThroughFocused((connector, listener) => connector.subscribeWork(listener))


export { armTypeaheadTimer, disarmTypeaheadTimer, typeaheadTimerCensus } from './typeahead/timers.js'


export type { SuggestionsState } from './typeahead/state.js'

type UseTypeaheadProps = Unbuilt

type UseTypeaheadResult = Unbuilt


export function useTypeahead(props: UseTypeaheadProps): UseTypeaheadResult {
  return notBuilt('src/hooks/useTypeahead.tsx:78')
}
