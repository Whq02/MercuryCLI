import { refusalAnsweredBy } from '../../services/providers/toolCallGate.js'
import type { AssistantMessage, Message, ProgressMessage } from '../../types/message.js'
import type { EvalToolProgress, MCPProgress, ShellProgress } from '../../types/tools.js'
import type { HookProgress } from '../../types/hooks.js'
import { normalizeMessages } from '../../services/messages.js'
import { isNotEmptyMessage } from '../../utils/messages/text.js'
import { isEphemeralToolProgress } from '../../utils/sessionStorage/paths.js'
import { childRowsOf } from '../child.js'
import { itemRowsOf, refusedCallRowsOf, toolResultRowsOf, toolUpdateRow, type RowDraft, type RowScope } from '../project.js'
import type { StepLedger } from './steps.js'
import { notBuilt } from '../../pi/holes.js'

const TOOL_UPDATE_BEAT_MS = 250
const TOOL_UPDATE_MAP_CAP = 100
const TOOL_UPDATE_LINE_MAX = 300
const toolUpdateState = new Map<string, { lastEmitMs: number; tick: number }>()

function latestLineOf(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line === '') continue
    return line.length > TOOL_UPDATE_LINE_MAX ? `${line.slice(0, TOOL_UPDATE_LINE_MAX)}…` : line
  }
  return undefined
}

interface MessageRowsNeeds {
  scope: RowScope
  steps: StepLedger
  toolOutcomes: Map<string, 'ok' | 'error' | 'aborted'>
  callScopes: Map<string, RowScope>
}

export function messageRowsOf(arg0: MessageRowsNeeds): (message: Message, parentCallId: string | undefined) => RowDraft[] {
  return notBuilt('src/rows/turn/messageRows.ts:35')
}
