import { useRef } from 'react';
import { createStore, type Store } from '../../state/store.js';

type ChatScreenState = {
  readonly resolvedConsentCount: number;
  readonly consentBatchIds: readonly string[];
};

export type ChatScreenStore = Store<ChatScreenState>;

const EMPTY_CONSENT_BATCH: readonly string[] = [];

const INITIAL_CHAT_SCREEN_STATE: ChatScreenState = {
  resolvedConsentCount: 0,
  consentBatchIds: EMPTY_CONSENT_BATCH,
};

export function createChatScreenStore(): ChatScreenStore {
  return createStore<ChatScreenState>(INITIAL_CHAT_SCREEN_STATE);
}

export function useChatScreenStore(): ChatScreenStore {
  const storeRef = useRef<ChatScreenStore | null>(null);
  if (storeRef.current === null) storeRef.current = createChatScreenStore();
  return storeRef.current;
}

export function selectResolvedConsentCount(
  state: ChatScreenState,
  currentToolUseIds: readonly string[],
): number {
  if (state.resolvedConsentCount === 0 || currentToolUseIds.length === 0) return 0;
  for (const id of currentToolUseIds) {
    if (state.consentBatchIds.includes(id)) return state.resolvedConsentCount;
  }
  return 0;
}

export function recordChatConsentResolved(
  store: ChatScreenStore,
  currentToolUseIds: readonly string[],
): void {
  store.setState(prev => {
    const remainingIds = currentToolUseIds.slice(1);
    if (remainingIds.length === 0) {
      return prev === INITIAL_CHAT_SCREEN_STATE ? prev : INITIAL_CHAT_SCREEN_STATE;
    }
    const sameBatch =
      prev.resolvedConsentCount > 0 &&
      currentToolUseIds.some(id => prev.consentBatchIds.includes(id));
    return {
      resolvedConsentCount: (sameBatch ? prev.resolvedConsentCount : 0) + 1,
      consentBatchIds: remainingIds,
    };
  });
}
