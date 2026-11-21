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

const SEARCH_WARMUP_QUIET_MS = 20;
const SEARCH_WARMUP_SHOW_MS = 2000;
const EDITOR_STATUS_MS = 4000;

type FrozenTranscriptState = { messageCount: number; streamingToolUseCount: number };

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
  const [warm, setWarm] = useState<'warming' | 'quiet' | number>('warming');
  const committedRef = useRef(false);
  const search = useSearchInput({
    isActive: true,
    onExit: () => {
      committedRef.current = true;
      onCommit(search.query);
    },
    onCancel,
    columns,
    backspaceExitsOnEmpty: false,
  });
  useLoad(() => {
    let live = true;
    const started = Date.now();
    void warmSearchIndex()
      .then(ms => {
        if (!live) return;
        const measured = Number.isFinite(ms) ? ms : Date.now() - started;
        setWarm(measured < SEARCH_WARMUP_QUIET_MS ? 'quiet' : measured);
      })
      .catch(() => {
        if (live) setWarm('quiet');
      });
    return () => {
      live = false;
    };
  }, [warmSearchIndex]);
  useTimer(() => {
    if (typeof warm !== 'number') return;
    const timer = startTimeout(() => setWarm('quiet'), SEARCH_WARMUP_SHOW_MS);
    return () => stopTimeout(timer);
  }, [warm]);
  const { query } = search;
  usePublish(() => {
    if (warm === 'warming') return;
    onQueryChange(query);
  }, [query, warm, onQueryChange]);
  const before = query.slice(0, search.cursorOffset);
  const at = query.slice(search.cursorOffset, search.cursorOffset + 1) || ' ';
  const after = query.slice(search.cursorOffset + 1);
  let right: React.ReactNode;
  if (warm === 'warming') {
    right = <Text color={tokens.textSecondary}>indexing…</Text>;
  } else if (typeof warm === 'number') {
    right = <Text color={tokens.textSecondary}>{`indexed in ${warm}ms`}</Text>;
  } else if (query.length > 0 && matchCount === 0) {
    right = <Text color={tokens.failure}>no matches</Text>;
  } else if (matchCount !== null && matchCount > 0) {
    right = <Text color={tokens.textSecondary}>{`${matchCurrent}/${matchCount}`}</Text>;
  } else {
    right = null;
  }
  return (
    <Box
      flexDirection="row"
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
      <Box flexDirection="row" flexShrink={1} overflow="hidden">
        <Text color={tokens.textSecondary}>/</Text>
        <Text>{before}</Text>
        <Text inverse>{at}</Text>
        <Text>{after}</Text>
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        {right}
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
  const tokens = useMercuryTokens();
  const { columns } = useTerminalSize();
  let hints: string[];
  if (hasSearchBadge) {
    hints = ['n/N navigate matches'];
  } else if (virtualScroll) {
    hints = ['q quits', '/ search', 'g/G jump', 'arrows scroll', 'drag selects and copies'];
  } else if (!showAllSuppressed) {
    hints = [`${expandChord} ${showAll ? 'to collapse' : 'to show all'}`];
  } else {
    hints = [];
  }
  const right = status ?? badge ?? '';
  const rightBudget = right === '' ? 0 : Math.min(stringWidth(right), Math.max(16, Math.floor((columns - 3) / 2)));
  const rightWidth = right === '' ? 0 : rightBudget + 1;
  const left = packHints(
    ['detailed transcript', `${toggleChord} to toggle`, ...hints],
    Math.max(0, columns - 2 - rightWidth),
  );
  return (
    <Box
      flexDirection="row"
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
      <Box flexDirection="row" flexShrink={1} overflow="hidden">
        <Text color={tokens.textSecondary} wrap="truncate">
          {left}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1} width={rightBudget}>
        {right !== '' ? (
          <Text color={tokens.textSecondary} wrap="truncate-start">
            {right}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
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
}: {
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
}) {
  const [dumpMode, setDumpMode] = useState(false);
  const inVirtualTranscriptMode = fullscreen && virtualScrollEnabled && !dumpMode;
  const [screen, setScreen] = useState<Screen>('prompt');
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  const [frozenTranscriptState, setFrozenTranscriptState] = useState<FrozenTranscriptState | null>(null);
  const [searchBarOpen, setSearchBarOpen] = useState(false);
  const [committedSearchQuery, setCommittedSearchQuery] = useState('');
  const [searchMatchCount, setSearchMatchCount] = useState<number | null>(null);
  const [searchMatchCurrent, setSearchMatchCurrent] = useState(0);
  const [editorStatus, setEditorStatus] = useState<string | null>(null);
  const editorGenerationRef = useRef(0);
  const editorInFlightRef = useRef(false);
  const dumpFiredRef = useRef(false);
  const jumpRef = useRef<{ jumpToIndex: (i: number) => void; setSearchQuery: (q: string) => void; nextMatch: () => void; prevMatch: () => void; setAnchor: () => void; warmSearchIndex: () => Promise<number>; disarmSearch: () => void } | null>(null);
  const handleEnterTranscript = useCallback(() => {
    captureScrollForFlip();
    setFrozenTranscriptState({
      messageCount: getFocusedSessionConnector().records().length,
      streamingToolUseCount: 0,
    });
    setFlipGeneration(g => g + 1);
  }, [captureScrollForFlip]);
  const handleExitTranscript = useCallback(() => {
    captureScrollForFlip();
    setFrozenTranscriptState(null);
    setSearchBarOpen(false);
    setCommittedSearchQuery('');
    setSearchMatchCount(null);
    setSearchMatchCurrent(0);
    jumpRef.current?.disarmSearch();
    editorGenerationRef.current += 1;
    setEditorStatus(null);
    setDumpMode(false);
    dumpFiredRef.current = false;
    setFlipGeneration(g => g + 1);
  }, [captureScrollForFlip]);
  const inTranscript = screen === 'transcript';
  const inVirtualTranscript = inTranscript && inVirtualTranscriptMode;
  const legacyTranscript = inTranscript && !inVirtualTranscriptMode;

  const { setQuery: setHighlight, scanElement, setPositions } = useSearchHighlight();
  usePublish(() => {
    if (!inTranscript) {
      setHighlight('');
      setPositions(null);
      return;
    }
    setHighlight(highlightTextOf(committedSearchQuery));
  }, [inTranscript, committedSearchQuery, setHighlight, setPositions]);
  useTimer(() => {
    if (!editorStatus) return;
    const timer = startTimeout(() => setEditorStatus(null), EDITOR_STATUS_MS);
    return () => stopTimeout(timer);
  }, [editorStatus]);
  const [prevColumns, setPrevColumns] = useState(columns);
  const [columnResetSeq, setColumnResetSeq] = useState(0);
  if (prevColumns !== columns) {
    setPrevColumns(columns);
    if (searchBarOpen || committedSearchQuery !== '') {
      setSearchBarOpen(false);
      setCommittedSearchQuery('');
      setSearchMatchCount(null);
      setSearchMatchCurrent(0);
      setColumnResetSeq(seq => seq + 1);
    }
  }
  const lastColumnResetSeqRef = useRef(0);
  usePublish(() => {
    if (columnResetSeq === lastColumnResetSeqRef.current) return;
    lastColumnResetSeqRef.current = columnResetSeq;
    jumpRef.current?.disarmSearch();
    setHighlight('');
  }, [columnResetSeq, setHighlight]);

  const openTranscriptInEditor = useCallback(() => {
    if (editorInFlightRef.current) return;
    editorInFlightRef.current = true;
    const generation = editorGenerationRef.current;
    setEditorStatus('rendering transcript…');
    void (async () => {
      try {
        const text = await renderMessagesToPlainText([...getFocusedSessionConnector().records()], mergedTools, Math.max(80, columns - 6));
        const cleaned = text
          .split('\n')
          .map(line => line.replace(/\s+$/, ''))
          .join('\n');
        const path = join(tmpdir(), `mercury-transcript-${Date.now()}.md`);
        writeFileSync(path, cleaned, 'utf8');
        if (generation !== editorGenerationRef.current) return;
        const { openFileInExternalEditor } = await import('../../utils/editor.js');
        if (openFileInExternalEditor(path)) {
          setEditorStatus(`opening ${path}`);
        } else {
          setEditorStatus(
            process.platform === 'win32'
              ? `written to ${path} — set EDITOR (or VISUAL) to open it`
              : `written to ${path} — set $EDITOR to open it`,
          );
        }
      } catch (error) {
        if (generation === editorGenerationRef.current) setEditorStatus(`render failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        editorInFlightRef.current = false;
      }
    })();
  }, [columns, mergedTools]);

  useInput(
    (input, key) => {
      if (currentSurfaceRoute().kind !== 'repl') return;
      if (key.ctrl || key.meta) return;
      if (input === '/' && !searchBarOpen) {
        jumpRef.current?.setAnchor();
        setSearchBarOpen(true);
        return;
      }
      if ((input === 'n' || input === 'N') && !searchBarOpen && !dumpMode && searchMatchCount !== null && searchMatchCount > 0) {
        for (const ch of input) {
          if (ch === 'n') jumpRef.current?.nextMatch();
          else jumpRef.current?.prevMatch();
        }
        return;
      }
      if (input === 'q' && !searchBarOpen) {
        handleExitTranscript();
        setScreen('prompt');
        return;
      }
      if (input === 'g' && !searchBarOpen) {
        scrollRestoreRef.current = null;
        scrollRef.current?.scrollTo(0);
        return;
      }
      if (input === 'G' && !searchBarOpen) {
        scrollRestoreRef.current = null;
        scrollRef.current?.scrollToBottom();
        return;
      }
      if (input === '[' && !searchBarOpen && !dumpFiredRef.current) {
        dumpFiredRef.current = true;
        setShowAllInTranscript(true);
        setDumpMode(true);
        return;
      }
      if (input === 'v' && !searchBarOpen) {
        openTranscriptInEditor();
      }
    },
    { isActive: inTranscript && focusedInputDialog === undefined },
  );

  const commitSearch = useCallback((query: string) => {
    setSearchBarOpen(false);
    if (query === '' || searchMatchCount === 0) {
      setCommittedSearchQuery('');
      setSearchMatchCount(null);
      setSearchMatchCurrent(0);
      jumpRef.current?.setSearchQuery('');
      setHighlight('');
      return;
    }
    setCommittedSearchQuery(query);
  }, [searchMatchCount, setHighlight]);
  const cancelSearch = useCallback(() => {
    setSearchBarOpen(false);
    jumpRef.current?.setSearchQuery('');
    jumpRef.current?.setSearchQuery(committedSearchQuery);
    setHighlight(highlightTextOf(committedSearchQuery));
  }, [committedSearchQuery, setHighlight]);
  const previewSearch = useCallback((query: string) => {
    jumpRef.current?.setSearchQuery(query);
    setHighlight(highlightTextOf(query));
  }, [setHighlight]);
  const warmSearchIndex = useCallback(() => jumpRef.current?.warmSearchIndex() ?? Promise.resolve(0), []);
  const onSearchMatchesChange = useCallback((count: number, current: number) => {
    setSearchMatchCount(count);
    setSearchMatchCurrent(current);
  }, []);
  usePublish(() => {
    if (!inTranscript) return;
    if (committedSearchQuery === '') return;
    jumpRef.current?.setSearchQuery(committedSearchQuery);
  }, [inTranscript, committedSearchQuery]);
  useKeybinding('app:interrupt', () => {
    if (searchBarOpen) cancelSearch();
  }, { isActive: searchBarOpen });
  const transcriptMessages = useMemo(
    () => (frozenTranscriptState ? messages.slice(0, frozenTranscriptState.messageCount) : messages),
    [messages, frozenTranscriptState],
  );
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
    handle.scrollTo(Math.max(0, handle.getScrollHeight() - handle.getViewportHeight()));
    handle.scrollToBottom();
    onTranscriptScroll(true, handle);
  }, [onTranscriptScroll]);
  return {
    dumpMode,
    inVirtualTranscriptMode,
    screen,
    setScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    searchBarOpen,
    committedSearchQuery,
    searchMatchCount,
    searchMatchCurrent,
    editorStatus,
    jumpRef,
    handleEnterTranscript,
    handleExitTranscript,
    inTranscript,
    inVirtualTranscript,
    legacyTranscript,
    scanElement,
    setPositions,
    commitSearch,
    cancelSearch,
    previewSearch,
    warmSearchIndex,
    onSearchMatchesChange,
    transcriptMessages,
    onTranscriptScroll,
    onTranscriptPillClick,
  };
}
