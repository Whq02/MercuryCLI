import * as React from 'react'
import { useRef, useState } from 'react'
import { Box, Text, useInput, wrapText } from '../ink.js'
import { useClaim, useLayoutClaim, useLayoutPublish, useLoad, useTimer } from '../hooks/effects.js'
import { useRegisterOverlay } from '../context/overlayContext.js'
import TextInput from './TextInput.js'
import { HuggingfaceConnect } from './HuggingfaceConnect.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { fitMeasuredWindow, paneWindow } from './mercury-ui/geometry.js'
import { wrapPlain } from './BootHealthScreen.js'
import { truncateToWidth } from '../utils/glyphs.js'
import { POPUP_PAGE_HINT, PopupListViewport, popupListMotion } from './CustomSelect/popup-list.js'
import { MenuFilterLine } from './mercury-ui/menuFold.js'
import { LLM_HOST_SEARCH_MIN_CHARS, LLM_HOST_SEARCH_SETTLE_MS, LLM_HOST_WORDS as words } from '../commands/llmhost/words.js'
import { isSearchCharacter } from '../utils/model/modelPickerGroups.js'
import { formatDuration } from '../utils/format.js'
import { runLlmHost, type LlmHostEvent, type LlmHostQuestion, type LlmHostResult, type LlmHostRoad } from '../services/llmHost/index.js'
import { startInterval, startTimeout, stopInterval, stopTimeout } from '../utils/timers.js'
import { notBuilt } from '../pi/holes.js'

type QuestionRow = NonNullable<LlmHostQuestion['rows']>[number]
const rowMatches = (row: QuestionRow, query: string): boolean => row.label.replace(/^─+\n/, '').split(' · ')[0]!.toLowerCase().includes(query.toLowerCase())
const visibleRowsOf = (plan: LlmHostQuestion | null, query: string): QuestionRow[] => !plan?.rows ? [] : plan.search && query ? plan.rows.filter(row => rowMatches(row, query)) : [...plan.rows]

export function LlmHostDialog(arg0: {
  width: number
  rowBudget: number
  road?: LlmHostRoad
  onLine?: (line: string) => void
  onHint?: (hint: string | null) => void
  onOwnsEscape?: (owns: boolean) => void
  onClose?: () => void
}): React.ReactNode {
  return notBuilt('src/components/LlmHostDialog.tsx:25')
}
