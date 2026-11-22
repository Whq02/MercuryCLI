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
import { editorNotConfiguredWords } from '../../utils/platform/words.js';
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const SEARCH_WARMUP_QUIET_MS = 20;
const SEARCH_WARMUP_SHOW_MS = 2000;
const EDITOR_STATUS_MS = 4000;

type FrozenTranscriptState = { messageCount: number; streamingToolUseCount: number };

export function highlightTextOf(query: string): string {
  return parseSearchQuery(query).text ?? '';
}

export function TranscriptSearchBar(arg0: {
  columns: number;
  onQueryChange: (query: string) => void;
  onCommit: (query: string) => void;
  onCancel: () => void;
  warmSearchIndex: () => Promise<number>;
  matchCount: number | null;
  matchCurrent: number;
}): React.ReactNode {
  return notBuilt('src/screens/chat/useChatSearch.tsx:37')
}

export function TranscriptFooter(arg0: {
  toggleChord: string;
  expandChord: string;
  hasSearchBadge: boolean;
  virtualScroll: boolean;
  showAllSuppressed: boolean;
  showAll: boolean;
  status: string | null;
  badge: string | null;
}): React.ReactNode {
  return notBuilt('src/screens/chat/useChatSearch.tsx:135')
}

export function useChatSearch(arg0: {
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
}): Unbuilt {
  return notBuilt('src/screens/chat/useChatSearch.tsx:202')
}
