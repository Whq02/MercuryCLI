import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js';
import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { useLoad } from '../hooks/effects.js'
import { Box, Text, useInput } from '../ink.js'
import type { SuggestionItem } from './PromptInput/PromptInputFooterSuggestions.js'
import TextInput from './TextInput.js'
import { CommandCenter, EmptyState } from './mercury-ui/components.js'
import { displayWidth, GLYPH, truncateToWidth } from '../utils/glyphs.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { applyNavMotion, decodeNavKey } from './mercury-ui/navSemantics.js'
import { cockpitBottomSlotReserve, viewportRows } from './mercury-ui/geometry.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { notBuilt } from '../pi/holes.js'


type FileLoader = (query: string) => Promise<SuggestionItem[]>

export function runFileOpenLoad(
  query: string,
  loadFiles: FileLoader,
): Promise<{ results: SuggestionItem[]; error: string | null }> {
  return loadFiles(query)
    .then(results => ({ results, error: null }))
    .catch((error: unknown) => ({
      results: [],
      error: `could not list files (${error instanceof Error ? error.message : String(error)}) — edit the filter or retry`,
    }))
}

const defaultLoadFiles: FileLoader = async query => {
  const { generateFileSuggestions } = await import('../hooks/fileSuggestions.js')
  return generateFileSuggestions(query, true)
}

const PATH_WIDTH = 52
const QUERY_WIDTH = 56
const MAX_ROWS = 12
const HEIGHT_RESERVE = 26
const MIN_ROWS = 4

export function MercuryFileOpen(arg0: {
  onPick: (insertText: string) => void
  onClose: () => void
  isActive?: boolean
  loadFiles?: FileLoader
}): React.ReactNode {
  return notBuilt('src/components/MercuryFileOpen.tsx:43')
}
