import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useLoad, usePublish, useTimer } from '../../hooks/effects.js';
import { packHints } from '../../components/mercury-ui/geometry.js';
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js';
import { currentSurfaceRoute } from '../../context/surfaceRoute.js';
import { useSearchInput } from '../../hooks/useSearchInput.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js';
import type { JumpHandle } from '../../components/VirtualMessageList.js';
import type { DOMElement } from '../../ink/dom.js';
import type { SearchPositionsState } from '../../ink/hooks/use-search-highlight.js';
import type { MatchPosition } from '../../ink/render-to-screen.js';
import useInput from '../../ink/hooks/use-input.js';
import { useSearchHighlight } from '../../ink/hooks/use-search-highlight.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js';
import type { Tools } from '../../Tool.js';
import type { Message } from '../../types/message.js';
import { renderMessagesToPlainText } from '../../components/exportRenderer.js';
import { parseSearchQuery } from '../../utils/transcriptSearch.js';
import type { FocusedInputDialog } from './focusedDialog.js';
import type { Screen } from './screen.js';
import { startTimeout, stopTimeout } from '../../utils/timers.js';
import { openFileInExternalEditor } from '../../utils/editor.js';
import { editorNotConfiguredWords } from '../../utils/platform/words.js';

const SEARCH_WARMUP_QUIET_MS = 20;
const SEARCH_WARMUP_SHOW_MS = 2000;
const EDITOR_STATUS_MS = 4000;

type UseChatSearchProps = {
  fullscreen: boolean;
  virtualScrollEnabled: boolean;
  columns: number;
  mergedTools: Tools;
  messages: Message[];
  focusedInputDialog: FocusedInputDialog | undefined;
  captureScrollForFlip: () => void;
  setFlipGeneration: React.Dispatch<React.SetStateAction<number>>;
  scrollRef: React.RefObject<ScrollBoxHandle | null>;
  scrollRestoreRef: { current: unknown };
  onScroll: (sticky: boolean, handle: ScrollBoxHandle) => void;
};

type UseChatSearchResult = {
  screen: Screen;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  showAllInTranscript: boolean;
  setShowAllInTranscript: React.Dispatch<React.SetStateAction<boolean>>;
  dumpMode: boolean;
  searchBarOpen: boolean;
  committedSearchQuery: string;
  searchMatchCount: number | null;
  searchMatchCurrent: number;
  editorStatus: string | null;
  inVirtualTranscriptMode: boolean;
  inTranscript: boolean;
  inVirtualTranscript: boolean;
  legacyTranscript: boolean;
  handleEnterTranscript: () => void;
  handleExitTranscript: () => void;
  previewSearch: (query: string) => void;
  commitSearch: (query: string) => void;
  cancelSearch: () => void;
  warmSearchIndex: () => Promise<number>;
  onSearchMatchesChange: (count: number, current: number) => void;
  onTranscriptScroll: (sticky: boolean, handle: ScrollBoxHandle) => void;
  onTranscriptPillClick: () => void;
  jumpRef: React.RefObject<JumpHandle | null>;
  scanElement: (el: DOMElement) => MatchPosition[];
  setPositions: (state: SearchPositionsState | null) => void;
  transcriptMessages: Message[];
};

export function highlightTextOf(query: string): string {
  return parseSearchQuery(query).text ?? '';
}

export function TranscriptSearchBar({
  columns,
  onQueryChange,
  onCommit,
  onCancel,
  warmSearchIndex,
  matchCount,
  matchCurrent,
}: {
  columns: number;
  onQueryChange: (query: string) => void;
  onCommit: (query: string) => void;
  onCancel: () => void;
  warmSearchIndex: () => Promise<number>;
  matchCount: number | null;
  matchCurrent: number;
}): React.ReactNode {
  const tokens = useMercuryTokens();
  const [warming, setWarming] = useState(true);
  const [warmNotice, setWarmNotice] = useState<string | null>(null);
  const queryRef = useRef('');

  const handleExit = useCallback(() => {
    onCommit(queryRef.current);
  }, [onCommit]);

  const { query, cursorOffset } = useSearchInput({
    isActive: true,
    columns: Math.max(1, columns - 4),
    backspaceExitsOnEmpty: false,
    onExit: handleExit,
    onCancel,
  });
  queryRef.current = query;

  useLoad(signal => {
    let noticeTimer: ReturnType<typeof startTimeout> | null = null;
    const startedAt = Date.now();
    warmSearchIndex().then(
      reportedMs => {
        if (signal.aborted) return;
        setWarming(false);
        const elapsed = Number.isFinite(reportedMs) ? reportedMs : Date.now() - startedAt;
        if (elapsed >= SEARCH_WARMUP_QUIET_MS) {
          setWarmNotice(`indexed in ${Math.round(elapsed)}ms`);
          noticeTimer = startTimeout(() => setWarmNotice(null), SEARCH_WARMUP_SHOW_MS);
        }
      },
      () => {
        if (signal.aborted) return;
        setWarming(false);
      },
    );
    return () => {
      if (noticeTimer !== null) stopTimeout(noticeTimer);
    };
  }, [warmSearchIndex]);

  usePublish(() => {
    if (warming) return;
    onQueryChange(query);
  }, [warming, query, onQueryChange]);

  const before = query.slice(0, cursorOffset);
  const atCursor = cursorOffset < query.length ? query[cursorOffset] : ' ';
  const after = cursorOffset < query.length ? query.slice(cursorOffset + 1) : '';

  let rightNode: React.ReactNode = null;
  if (warming) {
    rightNode = <Text color={tokens.textSecondary}>indexing…</Text>;
  } else if (warmNotice !== null) {
    rightNode = <Text color={tokens.textSecondary}>{warmNotice}</Text>;
  } else if (query.length > 0 && matchCount === 0) {
    rightNode = <Text color={tokens.failure}>no matches</Text>;
  } else if (matchCount !== null && matchCount > 0) {
    rightNode = <Text color={tokens.textSecondary}>{`${matchCurrent}/${matchCount}`}</Text>;
  }

  return (
    <Box
      justifyContent="space-between"
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={tokens.borderSubtle}
      paddingX={1}
      height={2}
      noSelect
    >
      <Box flexShrink={1} overflow="hidden">
        <Text color={tokens.textSecondary}>/</Text>
        <Text>{before}</Text>
        <Text inverse>{atCursor}</Text>
        <Text>{after}</Text>
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        {rightNode}
      </Box>
    </Box>
  );
}

export function TranscriptFooter({
  toggleChord,
  expandChord,
  hasSearchBadge,
  virtualScroll,
  showAllSuppressed,
  showAll,
  status,
  badge,
}: {
  toggleChord: string;
  expandChord: string;
  hasSearchBadge: boolean;
  virtualScroll: boolean;
  showAllSuppressed: boolean;
  showAll: boolean;
  status: string | null;
  badge: string | null;
}): React.ReactNode {
  const { columns } = useTerminalSize();
  const tokens = useMercuryTokens();

  const hints: string[] = ['detailed transcript', `${toggleChord} to toggle`];
  if (hasSearchBadge) {
    hints.push('n/N navigate matches');
  } else if (virtualScroll) {
    hints.push('q quits', '/ search', 'g/G jump', 'arrows scroll', 'drag selects and copies');
  } else if (!showAllSuppressed) {
    hints.push(showAll ? `${expandChord} to collapse` : `${expandChord} to show all`);
  }

  const rightText = status ?? badge ?? '';
  const rightCap = Math.max(16, Math.floor((columns - 3) / 2));
  const rightWidth = rightText !== '' ? Math.min(stringWidth(rightText), rightCap) : 0;
  const rightReserve = rightWidth > 0 ? rightWidth + 1 : 0;
  const leftBudget = Math.max(0, columns - 2 - rightReserve);
  const leftText = packHints(hints, leftBudget);

  return (
    <Box
      justifyContent="space-between"
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={tokens.borderSubtle}
      paddingX={1}
      height={2}
    >
      <Box flexShrink={1} overflow="hidden">
        <Text color={tokens.textSecondary} wrap="truncate">
          {leftText}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1} width={rightWidth}>
        {rightText !== '' ? (
          <Text color={tokens.textSecondary} wrap="truncate-start">
            {rightText}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

function useTranscriptEditorExport(
  columns: number,
  mergedTools: Tools,
  transcriptVisitRef: React.RefObject<number>,
): {
  editorStatus: string | null;
  clearEditorStatus: () => void;
  exportTranscriptToEditor: () => void;
} {
  const [editorStatus, setEditorStatus] = useState<string | null>(null);
  const editorBusyRef = useRef(false);

  useTimer(() => {
    if (editorStatus === null || editorStatus === '') return;
    const timer = startTimeout(() => {
      setEditorStatus(null);
    }, EDITOR_STATUS_MS);
    return () => stopTimeout(timer);
  }, [editorStatus]);

  const clearEditorStatus = useCallback(() => {
    setEditorStatus(null);
  }, []);

  const exportTranscriptToEditor = useCallback(() => {
    if (editorBusyRef.current) return;
    editorBusyRef.current = true;
    const visit = transcriptVisitRef.current;
    setEditorStatus('rendering transcript…');
    const records = getFocusedSessionConnector().records();
    const width = Math.max(80, columns - 6);
    void (async () => {
      try {
        const rendered = await renderMessagesToPlainText([...records], mergedTools, width);
        const cleaned = rendered
          .split('\n')
          .map(line => line.trimEnd())
          .join('\n');
        const filePath = join(tmpdir(), `mercury-transcript-${Date.now()}.md`);
        writeFileSync(filePath, cleaned, 'utf8');
        if (transcriptVisitRef.current !== visit) return;
        const opened = openFileInExternalEditor(filePath);
        if (transcriptVisitRef.current !== visit) return;
        setEditorStatus(opened ? `opening ${filePath}` : editorNotConfiguredWords(filePath));
      } catch (err) {
        if (transcriptVisitRef.current === visit) {
          const detail = err instanceof Error ? err.message : String(err);
          setEditorStatus(`render failed: ${detail}`);
        }
      } finally {
        editorBusyRef.current = false;
      }
    })();
  }, [columns, mergedTools, transcriptVisitRef]);

  return { editorStatus, clearEditorStatus, exportTranscriptToEditor };
}

export function useChatSearch({
  fullscreen,
  virtualScrollEnabled,
  columns,
  mergedTools,
  messages,
  focusedInputDialog,
  captureScrollForFlip,
  setFlipGeneration,
  scrollRef,
  scrollRestoreRef,
  onScroll,
}: UseChatSearchProps): UseChatSearchResult {
  const [screen, setScreen] = useState<Screen>('prompt');
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  const [dumpMode, setDumpMode] = useState(false);
  const [searchBarOpen, setSearchBarOpen] = useState(false);
  const [committedSearchQuery, setCommittedSearchQuery] = useState('');
  const [searchMatchCount, setSearchMatchCount] = useState<number | null>(null);
  const [searchMatchCurrent, setSearchMatchCurrent] = useState(0);
  const [frozenMessageCount, setFrozenMessageCount] = useState<number | null>(null);

  const jumpRef = useRef<JumpHandle | null>(null);
  const transcriptVisitRef = useRef(0);
  const prevColumnsRef = useRef(columns);
  const { editorStatus, clearEditorStatus, exportTranscriptToEditor } = useTranscriptEditorExport(
    columns,
    mergedTools,
    transcriptVisitRef,
  );
  const committedQueryRef = useRef(committedSearchQuery);
  committedQueryRef.current = committedSearchQuery;
  const searchMatchCountRef = useRef(searchMatchCount);
  searchMatchCountRef.current = searchMatchCount;

  const { setQuery: setHighlightQuery, scanElement, setPositions } = useSearchHighlight();

  const inVirtualTranscriptMode = fullscreen && virtualScrollEnabled && !dumpMode;
  const inTranscript = screen === 'transcript';
  const inVirtualTranscript = inTranscript && inVirtualTranscriptMode;
  const legacyTranscript = inTranscript && !inVirtualTranscriptMode;

  const transcriptMessages = useMemo(
    () => (frozenMessageCount === null ? messages : messages.slice(0, frozenMessageCount)),
    [messages, frozenMessageCount],
  );

  const handleEnterTranscript = useCallback(() => {
    captureScrollForFlip();
    const messageCount = getFocusedSessionConnector().records().length;
    setFrozenMessageCount(messageCount);
    setFlipGeneration(g => g + 1);
  }, [captureScrollForFlip, setFlipGeneration]);

  const handleExitTranscript = useCallback(() => {
    captureScrollForFlip();
    setFrozenMessageCount(null);
    setSearchBarOpen(false);
    setCommittedSearchQuery('');
    setSearchMatchCount(null);
    setSearchMatchCurrent(0);
    jumpRef.current?.disarmSearch();
    transcriptVisitRef.current += 1;
    setDumpMode(false);
    clearEditorStatus();
    setFlipGeneration(g => g + 1);
  }, [captureScrollForFlip, clearEditorStatus, setFlipGeneration]);
  usePublish(() => {
    if (!inTranscript) {
      setHighlightQuery('');
      setPositions(null);
    }
  }, [inTranscript, setHighlightQuery, setPositions]);

  usePublish(() => {
    if (prevColumnsRef.current === columns) return;
    prevColumnsRef.current = columns;
    if (!searchBarOpen && committedSearchQuery === '') return;
    setSearchBarOpen(false);
    setCommittedSearchQuery('');
    setSearchMatchCount(null);
    setSearchMatchCurrent(0);
    jumpRef.current?.disarmSearch();
    setHighlightQuery('');
    setPositions(null);
  }, [columns, searchBarOpen, committedSearchQuery, setHighlightQuery, setPositions]);

  const previewSearch = useCallback(
    (query: string) => {
      jumpRef.current?.setSearchQuery(query);
      setHighlightQuery(highlightTextOf(query));
    },
    [setHighlightQuery],
  );

  const commitSearch = useCallback(
    (query: string) => {
      setSearchBarOpen(false);
      if (query === '' || searchMatchCountRef.current === 0) {
        setCommittedSearchQuery('');
        setSearchMatchCount(null);
        setSearchMatchCurrent(0);
        jumpRef.current?.setSearchQuery('');
        setHighlightQuery('');
        setPositions(null);
        return;
      }
      setCommittedSearchQuery(query);
      jumpRef.current?.setSearchQuery(query);
      setHighlightQuery(highlightTextOf(query));
    },
    [setHighlightQuery, setPositions],
  );

  const cancelSearch = useCallback(() => {
    setSearchBarOpen(false);
    jumpRef.current?.setSearchQuery('');
    const committed = committedQueryRef.current;
    if (committed !== '') {
      jumpRef.current?.setSearchQuery(committed);
      setHighlightQuery(highlightTextOf(committed));
    } else {
      setHighlightQuery('');
      setPositions(null);
    }
  }, [setHighlightQuery, setPositions]);

  const warmSearchIndex = useCallback(
    () => jumpRef.current?.warmSearchIndex() ?? Promise.resolve(0),
    [],
  );

  const onSearchMatchesChange = useCallback((count: number, current: number) => {
    setSearchMatchCount(count);
    setSearchMatchCurrent(current);
  }, []);

  const onTranscriptScroll = useCallback(
    (sticky: boolean, handle: ScrollBoxHandle) => {
      jumpRef.current?.disarmSearch();
      onScroll(sticky, handle);
    },
    [onScroll],
  );

  const onTranscriptPillClick = useCallback(() => {
    const handle = scrollRef.current;
    if (!handle) return;
    const maxY = Math.max(0, handle.getScrollHeight() - handle.getViewportHeight());
    handle.scrollTo(maxY);
    handle.scrollToBottom();
    onScroll(true, handle);
  }, [scrollRef, onScroll]);

  useKeybinding('app:interrupt', cancelSearch, {
    context: 'Global',
    isActive: searchBarOpen,
  });

  useInput(
    (input, key) => {
      if (currentSurfaceRoute().kind !== 'repl') return;
      if (key.ctrl || key.meta) return;
      if (input === '/') {
        jumpRef.current?.setAnchor();
        setSearchBarOpen(true);
        return;
      }
      if (input === 'n') {
        if (!dumpMode && committedSearchQuery !== '' && searchMatchCount !== null && searchMatchCount > 0) {
          jumpRef.current?.nextMatch();
        }
        return;
      }
      if (input === 'N') {
        if (!dumpMode && committedSearchQuery !== '' && searchMatchCount !== null && searchMatchCount > 0) {
          jumpRef.current?.prevMatch();
        }
        return;
      }
      if (input === 'q') {
        handleExitTranscript();
        setScreen('prompt');
        return;
      }
      if (input === 'g') {
        scrollRestoreRef.current = null;
        scrollRef.current?.scrollTo(0);
        return;
      }
      if (input === 'G') {
        scrollRestoreRef.current = null;
        scrollRef.current?.scrollToBottom();
        return;
      }
      if (input === '[') {
        if (!dumpMode) {
          setDumpMode(true);
          setShowAllInTranscript(true);
        }
        return;
      }
      if (input === 'v') {
        exportTranscriptToEditor();
      }
    },
    { isActive: inTranscript && focusedInputDialog === undefined && !searchBarOpen },
  );

  return {
    screen,
    setScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    dumpMode,
    searchBarOpen,
    committedSearchQuery,
    searchMatchCount,
    searchMatchCurrent,
    editorStatus,
    inVirtualTranscriptMode,
    inTranscript,
    inVirtualTranscript,
    legacyTranscript,
    handleEnterTranscript,
    handleExitTranscript,
    previewSearch,
    commitSearch,
    cancelSearch,
    warmSearchIndex,
    onSearchMatchesChange,
    onTranscriptScroll,
    onTranscriptPillClick,
    jumpRef,
    scanElement,
    setPositions,
    transcriptMessages,
  };
}
