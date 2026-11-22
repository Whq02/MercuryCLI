import * as React from 'react'

import { truncatePathMiddle } from '../../utils/truncate.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { isDenialResultText } from '../../utils/messages/rejectionText.js'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage.js'
import { FileEditToolDiff } from '../../components/FileEditToolDiff.js'
import { consentContentWidth } from '../../components/permissions/consentBodyBudget.js'
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { HighlightedCode } from '../../components/HighlightedCode.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { GLYPH } from '../../utils/glyphs.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { getDisplayPath } from '../../utils/file.js'
import { firstLineOf } from '../../utils/stringUtils.js'
import { toolErrorReason } from '../../utils/toolErrorReason.js'
import type { FileEditInput, FileEditOutput } from './types.js'
import { notBuilt } from '../../pi/holes.js'


export function userFacingName(input?: Partial<FileEditInput>): string {
  return notBuilt('src/tools/FileEditTool/UI.tsx:24')
}

export function getToolUseSummary(input: Partial<FileEditInput> | undefined): string | null {
  return notBuilt('src/tools/FileEditTool/UI.tsx:29')
}

export function renderToolUseMessage(
  input: Partial<FileEditInput>,
  arg1: { verbose: boolean },
): React.ReactNode {
  return notBuilt('src/tools/FileEditTool/UI.tsx:34')
}

export function renderToolResultMessage(
  output: FileEditOutput,
  _progressMessages: unknown,
  arg2: { verbose: boolean; style?: 'condensed' | 'default' },
): React.ReactNode {
  return notBuilt('src/tools/FileEditTool/UI.tsx:57')
}

export function renderToolUseRejectedMessage(
  input?: Partial<FileEditInput>,
  options?: { verbose?: boolean; width?: number | string },
): React.ReactNode {
  return notBuilt('src/tools/FileEditTool/UI.tsx:77')
}

function ShortErrorLine(arg0: { text: string }): React.ReactNode {
  return notBuilt('src/tools/FileEditTool/UI.tsx:106')
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string' && !isDenialResultText(result)) {
    return <ShortErrorLine text={toolErrorReason(result, 'Error editing file')} />
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
