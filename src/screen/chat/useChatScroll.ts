import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useMeasure, usePublish } from '../effects/effects.js';
import { computeUnseenDivider, countUnseenAssistantTurns, useUnseenDivider } from '../fullscreen-layout/FullscreenLayout.js';
import { setMessageCursor } from '../messages/messageCursorStore.js';
import { ScreenInstanceContext } from '../renderer/elements/ScreenInstanceContext.js';
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js';
import type { Message } from '../../engine/message-shapes/message.js';
import { isHumanTurn } from './messagePredicates.js';

export type ScrollRestore = { gap: number; sticky: boolean };

export function useChatScrollPin() {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const scrollRestoreRef = useRef<ScrollRestore | null>(null);
  const modalScrollRef = useRef<ScrollBoxHandle | null>(null);
  const lastUserScrollAtRef = useRef(0);
  const repinToBottom = useCallback(() => {
    scrollRestoreRef.current = null;
    scrollRef.current?.scrollToBottom();
  }, []);
  const noteUserScroll = useCallback(() => {
    lastUserScrollAtRef.current = Date.now();
  }, []);
  return { scrollRef, scrollRestoreRef, modalScrollRef, lastUserScrollAtRef, repinToBottom, noteUserScroll };
}

export function useChatScroll({
  messages,
  fullscreen,
  scrollRef,
  scrollRestoreRef,
  noteUserScroll,
}: {
  messages: Message[];
  fullscreen: boolean;
  scrollRef: React.RefObject<ScrollBoxHandle | null>;
  scrollRestoreRef: React.MutableRefObject<ScrollRestore | null>;
  noteUserScroll: () => void;
}) {
  const unseen = useUnseenDivider(messages.length, scrollRef);
  const captureScrollForFlip = useCallback(() => {
    const handle = scrollRef.current;
    if (!handle) {
      scrollRestoreRef.current = null;
      return;
    }
    const gap = Math.max(0, handle.getFreshScrollHeight() - handle.getViewportHeight() - handle.getScrollTop());
    scrollRestoreRef.current = { gap, sticky: handle.isSticky() || gap === 0 };
  }, []);
  const [flipGeneration, setFlipGeneration] = useState(0);
  const flipInk = React.useContext(ScreenInstanceContext);
  useMeasure(() => {
    const restore = scrollRestoreRef.current;
    if (!restore || !flipInk) return;
    if (!restore.sticky && scrollRef.current) {
      const handle = scrollRef.current;
      type ScrollNodeLike = {
        style?: { overflowY?: string; paddingTop?: number; paddingBottom?: number };
        scroll?: { scrollTop?: number; scrollViewportHeight?: number };
        layoutNode?: { getComputedWidth: () => number; getComputedHeight: () => number };
        childNodes?: readonly ScrollNodeLike[];
      };
      const syncViewport = (node: ScrollNodeLike | undefined): number | undefined => {
        if (!node) return undefined;
        if (
          node.style?.overflowY === 'scroll' &&
          node.scroll !== undefined &&
          (node.scroll.scrollTop ?? 0) === handle.getScrollTop() &&
          (node.scroll.scrollViewportHeight ?? 0) === handle.getViewportHeight() &&
          node.layoutNode &&
          node.layoutNode.getComputedWidth() > 0
        ) {
          const inner = Math.max(0, Math.floor(node.layoutNode.getComputedHeight()) - (node.style.paddingTop ?? 0) - (node.style.paddingBottom ?? 0));
          node.scroll.scrollViewportHeight = inner;
          return inner;
        }
        for (const child of node.childNodes ?? []) {
          const found = syncViewport(child);
          if (found !== undefined) return found;
        }
        return undefined;
      };
      const viewport = syncViewport(flipInk.rootNode) ?? handle.getViewportHeight();
      const freshHeight = handle.getFreshScrollHeight();
      if (freshHeight <= viewport) {
        scrollRestoreRef.current = null;
        unseen.dividerYRef.current = null;
        unseen.onRepin();
        handle.scrollToBottom();
        return;
      }
      const maxAboveTail = Math.max(0, freshHeight - viewport - 1);
      handle.scrollTo(Math.min(maxAboveTail, Math.max(0, freshHeight - viewport - restore.gap)));
    }
    const stop = flipInk.subscribeFrame(() => {
      if (scrollRestoreRef.current !== restore) {
        stop();
        return;
      }
      const handle = scrollRef.current;
      if (!handle) return;
      const target = Math.max(0, handle.getFreshScrollHeight() - handle.getViewportHeight() - restore.gap);
      if (restore.sticky || handle.getScrollTop() === target) {
        stop();
        scrollRestoreRef.current = null;
        if (restore.sticky) handle.scrollToBottom();
      } else handle.scrollTo(target);
    });
    return stop;
  }, [flipGeneration, flipInk]);
  const unseenDivider = useMemo(
    () => (fullscreen ? computeUnseenDivider(messages, unseen.dividerIndex) : undefined),
    [fullscreen, messages, unseen.dividerIndex],
  );
  const newMessageCount = unseen.dividerIndex === null ? 0 : countUnseenAssistantTurns(messages, unseen.dividerIndex);
  const onScroll = useCallback(
    (sticky: boolean, handle: ScrollBoxHandle) => {
      scrollRestoreRef.current = null;
      noteUserScroll();
      if (sticky) unseen.onRepin();
      else unseen.onScrollAway(handle);
    },
    [noteUserScroll, unseen],
  );
  const onPillClick = useCallback(() => {
    scrollRestoreRef.current = null;
    setMessageCursor(null);
    unseen.jumpToNew(scrollRef.current);
  }, [unseen]);
  return { unseen, captureScrollForFlip, setFlipGeneration, unseenDivider, newMessageCount, onScroll, onPillClick };
}

export function useChatScrollFollow({ messages, repinToBottom }: { messages: Message[]; repinToBottom: () => void }): void {
  const lastMessage = messages[messages.length - 1];
  usePublish(() => {
    if (lastMessage && isHumanTurn(lastMessage)) repinToBottom();
  }, [lastMessage, repinToBottom]);
}
