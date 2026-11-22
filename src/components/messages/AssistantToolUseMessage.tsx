import React, { useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { ProgressMessage } from '../../types/message.js'
import type { ToolUseBlockParam } from '../../types/wire.js'
import type { Tools } from '../../Tool.js'
import { filterToolProgressMessages, safeUserFacingName } from '../../Tool.js'
import { findToolForRender } from '../../tools/MCPTool/absentToolShim.js'
import { BASH_TOOL_NAME } from '../../constants/tools/bash.js'
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js'
import { logError } from '../../utils/log.js'
import type { MessageLookups } from '../../services/messages/lookups.js'
import { summarizeToolResult } from '../../tools/toolResultSummary.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { getSettingsSnapshot, settingsRevision } from '../../utils/settings/snapshot.js'
import { useFluxMountMark } from '../../hooks/useFluxMountMark.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useTerminalFocus } from '../../ink/hooks/use-terminal-focus.js'
import { useActionAffordance } from '../../keybindings/useShortcutDisplay.js'
import {
  BACKGROUND_HINT_ACTION,
  BACKGROUND_HINT_AFTER_MS,
  BACKGROUND_HINT_WORDS,
  useFocusedShellToolRunning,
} from '../../services/engine-connector/shellRunning.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { useNowTick } from '../mercury-ui/components.js'
import { toolFamilyFor } from '../mercury-ui/toolGlyphs.js'
import { MessageResponse } from '../MessageResponse.js'
import { HookProgressMessage } from './HookProgressMessage.js'
import { ToolRowLead, toolRowStateOf } from './ToolRowLead.js'
import { TranscriptNameplate } from './TranscriptNameplate.js'
import { useSelectedMessageBg } from '../messageActions.js'
import { notBuilt } from '../../pi/holes.js'

const EDIT_META_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const NAME_MIN_COLUMNS = 12
const ELAPSED_VISIBLE_MS = 10_000
const ELAPSED_TICK_MS = 960
const START_STAMP_BOUND = 256
const INLINE_SUMMARY_MAX_CELLS = 32


const toolStartStamps = new Map<string, number>()

function seedStamp(id: string, at: number): void {
  if (!toolStartStamps.has(id) && toolStartStamps.size >= START_STAMP_BOUND) {
    const oldest = toolStartStamps.keys().next().value
    if (oldest !== undefined) toolStartStamps.delete(oldest)
  }
  toolStartStamps.set(id, at)
}

export function _seedToolStartStamp(id: string, at: number): void {
  seedStamp(id, at)
}

export function RunningToolElapsed({
  id,
  running,
  startedAtMs = null,
}: {
  id: string
  running: boolean
  startedAtMs?: number | null
}): React.ReactNode {
  const reducedMotion =
    useAppStateMaybeOutsideOfProvider(
      state => state.settings.view?.reducedMotion,
    ) ?? false
  const focused = useTerminalFocus()
  const ticking = running && focused && !reducedMotion
  useNowTick(ticking ? ELAPSED_TICK_MS : null)

  if (!running) {
    toolStartStamps.delete(id)
    return null
  }
  const recorded = startedAtMs !== null && Number.isFinite(startedAtMs) ? startedAtMs : null
  if (recorded !== null) {
    if (toolStartStamps.get(id) !== recorded) seedStamp(id, recorded)
  } else if (!toolStartStamps.has(id)) seedStamp(id, Date.now())
  const startedAt = toolStartStamps.get(id) ?? Date.now()
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  if (elapsedMs < ELAPSED_VISIBLE_MS) return null
  return <Text dimColor> · {Math.floor(elapsedMs / 1000)}s</Text>
}

export function RunningShellBackgroundHint({ id }: { id: string }): React.ReactNode {
  const reducedMotion =
    useAppStateMaybeOutsideOfProvider(
      state => state.settings.view?.reducedMotion,
    ) ?? false
  const focused = useTerminalFocus()
  const shellHere = useFocusedShellToolRunning(id)
  useSyncExternalStore(settingsChangeDetector.subscribe, settingsRevision, settingsRevision)
  const affordance = useActionAffordance(BACKGROUND_HINT_ACTION, 'Chat')
  const chord = affordance.kind === 'bound' ? affordance.chord : null
  const offered = shellHere && chord !== null && getSettingsSnapshot().settings.view?.backgroundKey !== false
  useNowTick(offered && focused && !reducedMotion ? ELAPSED_TICK_MS : null)
  if (!offered || chord === null) return null
  if (!toolStartStamps.has(id)) seedStamp(id, Date.now())
  const startedAt = toolStartStamps.get(id) ?? Date.now()
  if (Date.now() - startedAt < BACKGROUND_HINT_AFTER_MS) return null
  return (
    <Box paddingLeft={4}>
      <Text dimColor>
        <KeyboardShortcutHint shortcut={chord} action={BACKGROUND_HINT_WORDS} />
      </Text>
    </Box>
  )
}


function editMetaCounts(
  rawResult: unknown,
): { added: number; removed: number } | null {
  const patch = (rawResult as { structuredPatch?: Array<{ lines?: string[] }> })
    ?.structuredPatch
  if (!Array.isArray(patch)) return null
  let added = 0
  let removed = 0
  for (const hunk of patch) {
    for (const line of hunk.lines ?? []) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  if (added === 0 && removed === 0) return null
  return { added, removed }
}


export function AssistantToolUseMessage(arg0: {
  param: ToolUseBlockParam
  addMargin?: boolean
  tools: Tools
  commands?: unknown
  verbose?: boolean
  inProgressToolUseIDs: Set<string>
  progressMessagesForMessage?: ProgressMessage[]
  shouldAnimate?: boolean
  shouldShowDot?: boolean
  inProgressToolCallCount?: number
  lookups: MessageLookups
  isTranscriptMode?: boolean
  startedAtMs?: number | null
}): React.ReactNode {
  return notBuilt('src/components/messages/AssistantToolUseMessage.tsx:134')
}

export default AssistantToolUseMessage
