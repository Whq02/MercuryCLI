import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLoad, usePublish, useTimer } from '../effects/effects.js';
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js';
import { currentSurfaceRoute, settleAbsentChat } from '../routes/surfaceRoute.js';
import { rekeyCommandQueueToSession } from '../composer/input-core/command-queue.js';
import * as pendingInput from '../composer/input-core/pending-input.js';
import {
  enteringWarmth,
  entryLoadingLineOf,
  evictSessionWarmth,
  paintedTranscriptOf,
  sessionWarmthVersion,
  settleEntryWarmth,
  subscribeSessionWarmth,
} from '../concourse-model/sessionWarmth.js';
import { hasFocusedSession, landingInFlight, subscribeFocusedSessionConnector } from '../../engine/connector/focusedConnector.js';
import type { EngineConnectorV1 } from '../../engine/connector/types.js';
import type { AppState } from '../app-state/AppStateStore.js';
import type { SetToolJSXFn } from '../../tools/kit/tool.js';
import type { Message } from '../../engine/message-shapes/message.js';
import { isFullscreenEnvEnabled } from '../fullscreen-layout/fullscreen.js';
import type { ToolJSXState } from './useChatDialogs.js';
import { startTimeout, stopTimeout } from '../../platform/async/timers.js';

const NO_CHAT_SETTLE_MS = 150;

export function useChatConversation(focusedConnector: EngineConnectorV1) {
  const [conversationId, setConversationId] = useState<string>(() => focusedConnector.sessionId());
  return { conversationId, setConversationId };
}

export function useChatSession({
  focusedConnector,
  messages,
  compactWork,
  unseen,
  repinToBottom,
  setConversationId,
  setToolJSX,
  toolJSXRef,
  localJsx,
  landing,
  armedMessage,
  chatSurfaceCovered,
  inVirtualTranscript,
  transcriptMessages,
}: {
  focusedConnector: EngineConnectorV1;
  messages: Message[];
  compactWork: CompactWorkControls;
  unseen: { onRepin: () => void };
  repinToBottom: () => void;
  setConversationId: (id: string) => void;
  setToolJSX: SetToolJSXFn;
  toolJSXRef: { current: ToolJSXState };
  localJsx: boolean;
  landing: boolean;
  armedMessage: AppState['initialMessage'];
  chatSurfaceCovered: boolean;
  inVirtualTranscript: boolean;
  transcriptMessages: Message[];
}) {
  const warmthVersion = useSyncExternalStore(subscribeSessionWarmth, sessionWarmthVersion, sessionWarmthVersion);
  const focusedSessionId = focusedConnector.sessionId();
  const paintedMessages = useMemo(
    () => paintedTranscriptOf(messages, enteringWarmth(), focusedSessionId),
    [messages, warmthVersion, focusedSessionId],
  );
  const entryLoadingLine = entryLoadingLineOf(enteringWarmth(), messages.length === 0, focusedSessionId);
  usePublish(() => {
    const warmth = enteringWarmth();
    if (warmth === null) return;
    const focusedId = focusedConnector.sessionId();
    if (messages.length > 0 && focusedId === warmth.sessionId) {
      evictSessionWarmth(warmth.sessionId);
      settleEntryWarmth(warmth.sessionId);
    } else if (hasFocusedSession() && focusedId !== warmth.sessionId && focusedId !== warmth.coveredSessionId) {
      settleEntryWarmth(warmth.sessionId);
    }
  }, [messages, focusedConnector, warmthVersion]);
  const displayedMessages = inVirtualTranscript ? transcriptMessages : paintedMessages;

  const rekeyedSessionRef = useRef(focusedSessionId);
  useLoad(() => {
    compactWork.set('composer');
    unseen.onRepin();
    repinToBottom();
    setConversationId(focusedSessionId);
    const landing = rekeyedSessionRef.current === '' && focusedSessionId !== '';
    if (!landing) setToolJSX(null);
    if (rekeyedSessionRef.current !== focusedSessionId) {
      rekeyedSessionRef.current = focusedSessionId;
      void pendingInput.rekeyToSession(focusedSessionId === '' ? null : focusedSessionId, { landing });
      rekeyCommandQueueToSession(focusedSessionId === '' ? null : focusedSessionId, { landing });
    }
  }, [focusedSessionId]);
  const slotHasSession = useSyncExternalStore(subscribeFocusedSessionConnector, hasFocusedSession, hasFocusedSession);
  const armedMessageRef = useRef(armedMessage);
  armedMessageRef.current = armedMessage;
  useTimer(() => {
    if (slotHasSession || landing || chatSurfaceCovered || localJsx || armedMessage !== null) return;
    if (!isFullscreenEnvEnabled()) return;
    const settle = startTimeout(() => {
      if (hasFocusedSession() || landingInFlight() || currentSurfaceRoute().kind !== 'repl') return;
      if (toolJSXRef.current?.isLocalJSXCommand === true || armedMessageRef.current !== null) return;
      settleAbsentChat();
    }, NO_CHAT_SETTLE_MS);
    return () => stopTimeout(settle);
  }, [slotHasSession, landing, chatSurfaceCovered, localJsx, armedMessage]);
  return { warmthVersion, paintedMessages, entryLoadingLine, displayedMessages, slotHasSession };
}
