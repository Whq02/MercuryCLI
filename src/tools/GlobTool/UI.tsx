import * as React from 'react'

import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { isDenialResultText } from '../../utils/messages/rejectionText.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { GLYPH } from '../../utils/glyphs.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from '../../utils/file.js'
import { truncate } from '../../utils/format.js'
import { extractTag } from '../../services/messages.js'
import { SearchResultSummary } from '../GrepTool/UI.js'
import type { Output } from './GlobTool.js'
import { notBuilt } from '../../pi/holes.js'


type GlobRenderInput = { pattern?: string; path?: string }

export function userFacingName(): string {
  return notBuilt('src/tools/GlobTool/UI.tsx:20')
}

export function getToolUseSummary(input: GlobRenderInput | undefined): string | null {
  return notBuilt('src/tools/GlobTool/UI.tsx:24')
}

export function renderToolUseMessage(
  input: GlobRenderInput,
  arg1: { verbose: boolean },
): React.ReactNode {
  return notBuilt('src/tools/GlobTool/UI.tsx:29')
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  opts: { verbose: boolean; isTranscriptMode?: boolean },
): React.ReactNode {
  return notBuilt('src/tools/GlobTool/UI.tsx:45')
}

export function isResultTruncated(output: Output | undefined): boolean {
  return notBuilt('src/tools/GlobTool/UI.tsx:67')
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  arg1: { verbose: boolean },
): React.ReactNode {
  return notBuilt('src/tools/GlobTool/UI.tsx:82')
}
