import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { AgentProgressLine } from '../../components/AgentProgressLine.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { CtrlOToExpand, SubAgentProvider } from '../../components/CtrlOToExpand.js'
import { Byline } from '../../components/design-system/Byline.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { Message as MessageComponent } from '../../components/Message.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage.js'
import { ToolRowLead, toolRowStateOf } from '../../components/messages/ToolRowLead.js'
import type {
  AssistantMessage,
  NormalizedUserMessage,
  ProgressMessage,
} from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import { safeSearchOrReadClassification, safeUserFacingName } from '../../Tool.js'
import { buildSubagentLookups } from '../../services/messages.js'
import { formatTokens } from '../../utils/format.js'
import { getTokenCountFromUsage } from '../../services/context/tokens.js'
import type { ApiUsage, ToolResultBlockParam } from '../../types/wire.js'
import { renderModelName, getEngineModel } from '../../services/model/model.js'
import { Markdown } from '../../components/Markdown.js'
import { getAgentColor } from './agentColorManager.js'
import { useNowTick } from '../../components/mercury-ui/components.js'
import { useFocusedWorkRoster } from '../../components/tasks/useFocusedWork.js'
import {
  crewAgentByToolUse,
  crewAgentsOf,
  crewElapsedLabel,
  crewModelLabel,
  crewPhaseWords,
  crewStateLabel,
  crewTokensSummary,
  crewToolUsesLabel,
  type CrewAgentFacts,
} from '../../services/engine-connector/crewFacts.js'
import type { AgentToolOutput } from './AgentTool.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

function ExpandHint({ parens }: { parens?: boolean }): React.ReactNode {
  return (
    <ConfigurableShortcutHint
      action="app:toggleTranscript"
      context="Global"
      fallback="ctrl+o"
      description="expand"
      {...(parens ? { parens: true } : {})}
    />
  )
}

const GENERIC_AGENT_LABEL = 'crewmate'

type AgentProgressData = {
  type?: string
  message?: AssistantMessage | NormalizedUserMessage
  prompt?: string
  agentId?: string
}

type AgentUiInput = {
  description?: string
  prompt?: string
  crewmate_type?: string
  model?: string
  run_in_background?: boolean
  name?: string
}


function formatDuration(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms % 60_000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

function pluralise(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

type AgentProgressDataWithMessage = AgentProgressData & {
  message: AssistantMessage | NormalizedUserMessage
}

function hasProgressMessage(
  data: AgentProgressData | undefined,
): data is AgentProgressDataWithMessage {
  return Boolean(data && data.message)
}

function messagesOf(progressMessages: readonly ProgressMessage[]): Array<{
  progress: ProgressMessage
  data: AgentProgressDataWithMessage
}> {
  const rows: Array<{ progress: ProgressMessage; data: AgentProgressDataWithMessage }> =
    []
  for (const progress of progressMessages) {
    const data = (progress as { data?: AgentProgressData }).data
    if (!hasProgressMessage(data)) continue
    rows.push({ progress, data })
  }
  return rows
}

function displayRows(progressMessages: readonly ProgressMessage[]) {
  return messagesOf(progressMessages).filter(
    row => row.data.message!.type !== 'user',
  )
}

function latestTokenTotal(
  progressMessages: readonly ProgressMessage[],
): number {
  for (let i = progressMessages.length - 1; i >= 0; i--) {
    const data = (progressMessages[i] as { data?: AgentProgressData }).data
    const message = data?.message
    if (!message || message.type !== 'assistant') continue
    const usage = (message as AssistantMessage).message.usage
    if (!usage) continue
    return getTokenCountFromUsage(usage as ApiUsage)
  }
  return 0
}


function AgentPromptDisplay({
  prompt,
  dim,
}: {
  prompt: string
  theme?: unknown
  dim?: boolean
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold dimColor={dim}>
        Prompt:
      </Text>
      <Box marginLeft={2} flexDirection="column">
        <Markdown>{prompt}</Markdown>
      </Box>
    </Box>
  )
}

function AgentResponseDisplay({
  content,
}: {
  content: ReadonlyArray<{ type: 'text'; text: string }>
  theme?: unknown
}): React.ReactNode {
  const blocks = content.filter(block => block.text.trim() !== '')
  return (
    <Box flexDirection="column">
      <Text bold>Response:</Text>
      {blocks.map((block, index) => (
        <Box
          key={index}
          marginLeft={2}
          marginTop={index > 0 ? 1 : 0}
          flexDirection="column"
        >
          <Markdown>{block.text}</Markdown>
        </Box>
      ))}
    </Box>
  )
}

export function userFacingName(input?: AgentUiInput): string {
  const type = input?.crewmate_type
  if (!type || type === 'mercury-crew' || type === 'worker') {
    return GENERIC_AGENT_LABEL
  }
  return type
}

export function userFacingNameBackgroundColor(
  input?: AgentUiInput,
): string | undefined {
  return notBuilt('src/tools/AgentTool/UI.tsx:186')
}

export function renderToolUseMessage(
  input?: AgentUiInput,
): React.ReactNode | string | null {
  if (!input?.description || !input?.prompt) return null
  return input.description
}

export function renderToolUseTag(
  input?: AgentUiInput,
): React.ReactNode | string | null {
  const model = input?.model
  if (!model) return null
  try {
    if (model === getEngineModel()) return null
    return <Text dimColor>{renderModelName(model)}</Text>
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function hiddenAgentToolUses(
  progressMessages: readonly ProgressMessage[],
  tools: Tools,
): number {
  return notBuilt('src/tools/AgentTool/UI.tsx:215')
}

const VISIBLE_TAIL = 3
const CONDENSED_ROWS_PER_CALL = 9
const CONDENSED_ROWS_BASE = 7

export function renderToolUseProgressMessage(
  progressMessages: readonly ProgressMessage[],
  options: {
    tools: Tools
    verbose: boolean
    terminalSize?: { columns: number; rows: number }
    inProgressToolCallCount?: number
    isTranscriptMode?: boolean
    toolUseID?: string
  },
): React.ReactNode {
  return notBuilt('src/tools/AgentTool/UI.tsx:238')
}

const EMPTY_SET: Set<string> = new Set()

export function isResultTruncated(data: AgentToolOutput): boolean {
  const record = data as {
    status?: string
    content?: Array<{ text?: string }>
  }
  if (record.status !== 'completed' && record.status !== 'failed') {
    return false
  }
  return (
    Array.isArray(record.content) &&
    record.content.some(block => (block.text ?? '').trim() !== '')
  )
}

export function renderToolResultMessage(
  data: AgentToolOutput & { error?: string },
  progressMessages: readonly ProgressMessage[],
  options: {
    tools: Tools
    verbose: boolean
    theme?: unknown
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  return notBuilt('src/tools/AgentTool/UI.tsx:352')
}

export function renderToolUseRejectedMessage(
  input?: AgentUiInput,
  options?: {
    tools?: Tools
    verbose?: boolean
    progressMessagesForMessage?: ProgressMessage[]
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  void input
  const progress = options?.progressMessagesForMessage ?? []
  return (
    <Box flexDirection="column">
      {progress.length > 0
        ? renderToolUseProgressMessage(progress, {
            tools: options?.tools ?? [],
            verbose: options?.verbose ?? false,
            isTranscriptMode: options?.isTranscriptMode,
          })
        : null}
      <FallbackToolUseRejectedMessage />
    </Box>
  )
}

export function renderToolUseErrorMessage(
  result?: ToolResultBlockParam['content'],
  options?: {
    tools?: Tools
    verbose?: boolean
    progressMessagesForMessage?: ProgressMessage[]
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  const progress = options?.progressMessagesForMessage ?? []
  return (
    <Box flexDirection="column">
      {progress.length > 0
        ? renderToolUseProgressMessage(progress, {
            tools: options?.tools ?? [],
            verbose: options?.verbose ?? false,
            isTranscriptMode: options?.isTranscriptMode,
          })
        : null}
      <FallbackToolUseErrorMessage
        result={result}
        verbose={options?.verbose ?? false}
      />
    </Box>
  )
}


type GroupedToolUse = {
  toolUseID?: string
  toolUse?: { id?: string; input?: unknown }
  input?: AgentUiInput | string
  progressMessages?: ProgressMessage[]
  output?: AgentToolOutput | { status?: string }
  rawResult?: unknown
  isResolved?: boolean
  isErrored?: boolean
  isDenied?: boolean
}

function groupToolUseId(entry: GroupedToolUse): string | undefined {
  return entry.toolUseID ?? entry.toolUse?.id
}

function groupOutput(entry: GroupedToolUse): { status?: string } | undefined {
  const raw = entry.output ?? entry.rawResult
  return typeof raw === 'object' && raw !== null ? (raw as { status?: string }) : undefined
}

function parseGroupInput(entry: GroupedToolUse): AgentUiInput {
  const raw = entry.input ?? (entry.toolUse?.input as AgentUiInput | string | undefined)
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as AgentUiInput
    } catch (error) {
      passedOver(error)
      return {}
    }
  }
  return raw
}

type GroupedEntry = {
  toolUseID?: string
  input: AgentUiInput
  toolUseCount: number
  tokens: number
  lastTool: string | null
  output?: { totalToolUseCount?: number; totalTokens?: number }
  resolved: boolean
  isErrored: boolean
}

function factsForEntry(agents: readonly CrewAgentFacts[], entry: GroupedEntry): CrewAgentFacts | null {
  if (entry.toolUseID === undefined) return null
  return crewAgentByToolUse(agents, entry.toolUseID)
}

function factsStatusLine(facts: CrewAgentFacts, nowMs: number): string {
  const doing = crewPhaseWords(facts, nowMs) ?? crewStateLabel(facts)
  return `${doing} · ${crewElapsedLabel(facts, nowMs)}`
}

function CrewAgentRows({ entries, animate }: { entries: GroupedEntry[]; animate: boolean }): React.ReactNode {
  const roster = useFocusedWorkRoster()
  const agents = React.useMemo(() => crewAgentsOf(roster.rows, null), [roster])
  const anyRunning = React.useMemo(() => entries.some(entry => factsForEntry(agents, entry)?.running === true), [agents, entries])
  const now = useNowTick(animate || anyRunning ? 1000 : null)
  return (
    <>
      {entries.map((entry, index) => {
        const facts = factsForEntry(agents, entry)
        const resolved = entry.resolved || (facts !== null && !facts.running)
        const receiptTokens = (entry.output?.totalTokens ?? 0) > 0 ? entry.output!.totalTokens : undefined
        const tokensLabel =
          facts !== null
            ? (crewTokensSummary(facts) ?? undefined)
            : receiptTokens !== undefined
              ? `${formatTokens(receiptTokens)} spent`
              : entry.tokens > 0
                ? `${formatTokens(entry.tokens)} context`
                : undefined
        const toolUses = facts?.toolUses ?? entry.output?.totalToolUseCount ?? entry.toolUseCount
        const statusLine = facts !== null ? factsStatusLine(facts, now) : null
        return (
          <AgentProgressLine
            key={entry.toolUseID ?? index}
            agentType={userFacingName(entry.input)}
            {...(entry.input.description !== undefined ? { description: entry.input.description } : {})}
            {...(entry.input.crewmate_type ? { color: getAgentColor(entry.input.crewmate_type) } : {})}
            {...(facts !== null ? { model: crewModelLabel(facts) } : {})}
            {...(statusLine !== null ? { statusLine } : {})}
            {...(statusLine === null && entry.lastTool !== null ? { lastToolInfo: entry.lastTool } : {})}
            toolUseCount={toolUses}
            {...(tokensLabel !== undefined ? { tokensLabel } : {})}
            isLast={index === entries.length - 1}
            isResolved={resolved}
            isError={entry.isErrored || facts?.state === 'failed'}
            shouldAnimate={animate}
          />
        )
      })}
    </>
  )
}

function AgentFactsOrInitialising({ toolUseID }: { toolUseID?: string }): React.ReactNode {
  const roster = useFocusedWorkRoster()
  const facts = React.useMemo(
    () => (toolUseID === undefined ? null : crewAgentByToolUse(crewAgentsOf(roster.rows, null), toolUseID)),
    [roster, toolUseID],
  )
  const now = useNowTick(facts !== null && facts.running ? 1000 : null)
  if (facts === null) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Initializing crewmate…</Text>
      </MessageResponse>
    )
  }
  const parts = [
    crewModelLabel(facts),
    crewStateLabel(facts),
    crewToolUsesLabel(facts) ?? undefined,
    crewTokensSummary(facts) ?? undefined,
    crewElapsedLabel(facts, now),
    facts.activity ?? undefined,
  ].filter((part): part is string => part !== undefined)
  return (
    <MessageResponse height={1}>
      <Text dimColor>{parts.join(' · ')}</Text>
    </MessageResponse>
  )
}

export function renderGroupedAgentToolUse(
  toolUses: GroupedToolUse[],
  options: { shouldAnimate: boolean; tools: Tools },
): React.ReactNode {
  return notBuilt('src/tools/AgentTool/UI.tsx:725')
}
