import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { useAuthWallHold } from './useAuthWallHold.js';
import { useClaim } from '../effects/effects.js';
import type { VimMode } from '../composer/vim/useVimInput.js';
import * as pendingInput from '../composer/input-core/pending-input.js';
import { conversationIdHere, getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js';
import type { Message } from '../../engine/message-shapes/message.js';
import type { InputMode } from '../composer/input-core/textInput.js';
import { registerComposerSeeder, registerComposerSeedTrimmer } from '../cockpit/composerSeed.js';
import type { PastedContent } from '../../platform/config/schema.js';
import { consumeEarlyInput } from '../../boot/earlyInput.js';

const RECENT_SCROLL_REPIN_WINDOW_MS = 3000;

export function useChatDraft({
  messages,
  fullscreen,
  repinToBottom,
  lastUserScrollAtRef,
}: {
  messages: Message[];
  fullscreen: boolean;
  repinToBottom: () => void;
  lastUserScrollAtRef: { current: number };
}) {
  const isComposerActive = useSyncExternalStore(pendingInput.subscribeActive, pendingInput.active, pendingInput.active);
  const [inputMode, setInputModeState] = useState<InputMode>(() => pendingInput.mode());
  void inputMode;
  const [vimMode, setVimMode] = useState<VimMode>('INSERT');
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useState(() => {
    pendingInput.initSession(conversationIdHere(), consumeEarlyInput());
    return null;
  });
  const setInputValue = useCallback((value: string) => {
    pendingInput.edit(value);
  }, []);
  const setInputMode = useCallback((mode: InputMode) => {
    pendingInput.setMode(mode);
    setInputModeState(mode);
  }, []);
  const setPastedContents = useCallback((next: Record<number, PastedContent>) => {
    pendingInput.setPastedContents(next);
  }, []);
  const authWallHold = useAuthWallHold(
    messages,
    { text: () => pendingInput.text(), restore: (text: string) => setInputValue(text) },
    () => getFocusedSessionConnector().modelFacts().effective,
  );
  const insertTextRef = useRef<{ insert: (text: string) => void; setInputWithCursor: (value: string, cursor: number) => void; cursorOffset: number } | null>(null);
  useClaim(() => {
    return pendingInput.registerInterceptors({
      interceptSuggestion: () => false,
      onEmptyToNonempty: () => {
        if (!fullscreen) return;
        if (Date.now() - lastUserScrollAtRef.current < RECENT_SCROLL_REPIN_WINDOW_MS) return;
        repinToBottom();
      },
    });
  }, [fullscreen, repinToBottom]);

  useClaim(() => registerComposerSeeder(seed => pendingInput.append(seed)), []);
  useClaim(
    () =>
      registerComposerSeedTrimmer(() => {
        const words = pendingInput.text();
        if (words !== '') pendingInput.edit(words.slice(0, -1));
      }),
    [],
  );
  return { isComposerActive, setInputValue, setInputMode, setPastedContents, authWallHold, insertTextRef, vimMode, setVimMode, isSearchingHistory, setIsSearchingHistory, helpOpen, setHelpOpen };
}
