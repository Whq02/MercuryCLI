import * as React from 'react'
import { useLoad } from '../../hooks/effects.js'

import { truncatePathMiddle } from '../../utils/truncate.js'
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { isDenialResultText } from '../../utils/messages/rejectionText.js'
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js'
import { FileEditToolUseRejectedMessage } from '../../components/FileEditToolUseRejectedMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { HighlightedCode } from '../../components/HighlightedCode.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ToolCardMarker } from '../../components/mercury-ui/toolCardMeta.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { isRemotePath } from '../../utils/remoteFiles/target.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { getPatchForDisplay } from '../../utils/diff.js'
import { getDisplayPath } from '../../utils/file.js'
import { toolErrorReason } from '../../utils/toolErrorReason.js'
import { readFileInRange, FileTooLargeError } from '../../utils/readFileInRange.js'
import { countCharInString, firstLineOf, plural } from '../../utils/stringUtils.js'
import { FILE_WRITE_TOOL_NAME } from '../../constants/tools/fileWrite.js'
import { isSqliteRowTarget } from './structuredTargets.js'
import type { FileWriteToolInput, Output } from './FileWriteTool.js'
import { notBuilt } from '../../pi/holes.js'

export function userFacingName(input?: Partial<FileWriteToolInput>): string {
  return notBuilt('src/tools/FileWriteTool/UI.tsx:49')
}

export function getToolUseSummary(input: Partial<FileWriteToolInput> | undefined): string | null {
  return notBuilt('src/tools/FileWriteTool/UI.tsx:53')
}

export function renderToolUseMessage(
  input: Partial<FileWriteToolInput>,
  arg1: { verbose: boolean },
): React.ReactNode {
  return notBuilt('src/tools/FileWriteTool/UI.tsx:58')
}

export function isResultTruncated(output: Output | undefined): boolean {
  return notBuilt('src/tools/FileWriteTool/UI.tsx:70')
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  arg2: { verbose: boolean; style?: 'condensed' | 'default'; isTranscriptMode?: boolean },
): React.ReactNode {
  return notBuilt('src/tools/FileWriteTool/UI.tsx:118')
}

export function renderToolUseRejectedMessage(
  input?: Partial<FileWriteToolInput>,
  options?: { verbose?: boolean },
): React.ReactNode {
  return notBuilt('src/tools/FileWriteTool/UI.tsx:256')
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  arg1: { verbose: boolean },
): React.ReactNode {
  return notBuilt('src/tools/FileWriteTool/UI.tsx:278')
}
