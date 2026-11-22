import React from 'react'
import { exitChordNoticeText } from '../PromptInput/ExitChordNotice.js'
import { Box, Text, useInput } from '../../ink.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { useExitOnCtrlCD } from '../../hooks/useExitOnCtrlCD.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { ToolActivity } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { getAllBaseTools } from '../../tools.js'
import { getTheme } from '../../utils/theme.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { renderToolActivity } from './renderToolActivity.js'
import { agentLifecycleOf, getTaskStatusColor, getTaskStatusIcon } from './taskStatusUtils.js'
import { GLYPH } from '../../utils/glyphs.js'
import { notBuilt } from '../../pi/holes.js'

const PROMPT_CAP = 300

function statusWord(status: string): string {
  if (status === 'killed') return 'Stopped'
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return 'Failed'
  return status
}

export function AsyncAgentDetailDialog(arg0: {
  agent: LocalAgentTaskState
  onDone: () => void
  onKillAgent?: () => void
  onBack?: () => void
  onForeground?: () => void
}): React.ReactNode {
  return notBuilt('src/components/tasks/AsyncAgentDetailDialog.tsx:28')
}
