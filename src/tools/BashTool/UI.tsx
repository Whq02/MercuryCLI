import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { oneLineCommandDisplay, TOOL_USE_LINE_MAX_CHARS } from '../commandDisplay.js'
import { FAINT } from '../../components/mercuryPalette.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ShellProgressMessage } from '../../components/shell/ShellProgressMessage.js'
import BashToolResultMessage, { type BashResultContent } from './BashToolResultMessage.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { useAppStateStore } from '../../state/AppState.js'
import { backgroundAll } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { isInsideTmuxSync } from '../../utils/terminalDetection.js'
import { isSedInPlaceEdit, parseSedEditCommand } from './sedEditParser.js'
import { extractBashCommentLabel } from './commentLabel.js'
import { getDisplayPath } from '../../utils/file.js'
import { isFullscreenActive } from '../../utils/fullscreen.js'
import type { ProgressMessage } from '../../types/message.js'
import type { BashProgress } from '../../types/tools.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import { notBuilt } from '../../pi/holes.js'

type BashInput = {
  command?: string
  timeout?: number
  description?: string
}


export function renderToolUseMessage(
  input: Partial<BashInput>,
  arg1: { theme?: unknown; verbose: boolean; commands?: unknown },
): React.ReactNode {
  return notBuilt('src/tools/BashTool/UI.tsx:30')
}

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<BashProgress>[],
  arg1: {
    tools?: unknown
    verbose: boolean
    terminalSize?: { columns: number; rows: number }
    inProgressToolCallCount?: number
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  return notBuilt('src/tools/BashTool/UI.tsx:57')
}

export function renderToolUseQueuedMessage(): React.ReactNode {
  return (
    <Text color={FAINT} dimColor>
      waiting…
    </Text>
  )
}

export function renderToolResultMessage(
  content: BashResultContent,
  progressMessages: ProgressMessage<BashProgress>[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const timeoutMs = progressMessages[progressMessages.length - 1]?.data?.timeoutMs
  return (
    <BashToolResultMessage
      content={content}
      verbose={verbose}
      timeoutMs={timeoutMs}
    />
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { progressMessagesForMessage?: unknown; tools?: unknown; verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

export function BackgroundHint(arg0?: { onBackground?: () => void }): React.ReactNode {
  return notBuilt('src/tools/BashTool/UI.tsx:121')
}
