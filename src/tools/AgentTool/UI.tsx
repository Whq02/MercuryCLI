
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
import { ToolUseLoader } from '../../components/ToolUseLoader.js'
import type {
  AssistantMessage,
  NormalizedUserMessage,
  ProgressMessage,
} from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import { safeSearchOrReadClassification, safeUserFacingName } from '../../Tool.js'
import { buildSubagentLookups } from '../../utils/messages.js'
import { renderModelName, getMainLoopModel } from '../../utils/model/model.js'
import { Markdown } from '../../components/Markdown.js'
import { getAgentColor } from './agentColorManager.js'
import { useNowTick } from '../../components/mercury-ui/components.js'
import { useFocusedWorkRoster } from '../../components/tasks/useFocusedWork.js'
import {
  crewAgentByName,
  crewAgentByToolUse,
  crewAgentsOf,
  crewElapsedLabel,
  crewModelLabel,
  crewStateLabel,
  crewTokensLabel,
  crewToolUsesLabel,
  type CrewAgentFacts,
} from '../../services/engine-connector/crewFacts.js'
import type { AgentToolOutput } from './AgentTool.js'

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

const GENERIC_AGENT_LABEL = 'agent'

type AgentProgressData = {
  type?: string
  message?: AssistantMessage | NormalizedUserMessage
  prompt?: string
  agentId?: string
}

type AgentUiInput = {
  description?: string
  prompt?: string
  subagent_type?: string
  model?: string
  run_in_background?: boolean
  name?: string
  team_name?: string
}


function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
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

function messagesOf(progressMessages: readonly ProgressMessage[]): Array<{
  progress: ProgressMessage
  data: AgentProgressData
}> {
  const rows: Array<{ progress: ProgressMessage; data: AgentProgressData }> =
    []
  for (const progress of progressMessages) {
    const data = (progress as { data?: AgentProgressData }).data
    if (!data || !data.message) continue
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
    return (
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0)
    )
  }
  return 0
}


export function AgentPromptDisplay({
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

export function AgentResponseDisplay({
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
  const type = input?.subagent_type
  if (!type || type === 'general-purpose' || type === 'worker') {
    return GENERIC_AGENT_LABEL
  }
  return type
}

export function userFacingNameBackgroundColor(
  input?: AgentUiInput,
): string | undefined {
  const type = input?.subagent_type
  if (!type) return undefined
  return getAgentColor(type)
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
    if (model === getMainLoopModel()) return null
    return <Text dimColor>{renderModelName(model)}</Text>
  } catch {
    return null
  }
}

export function hiddenAgentToolUses(
  progressMessages: readonly ProgressMessage[],
  tools: Tools,
): number {
  void tools
  const rows = displayRows(progressMessages)
  const hidden = rows.slice(0, Math.max(0, rows.length - VISIBLE_TAIL))
  let count = 0
  for (const row of hidden) {
    const message = row.data.message!
    const content = message.message.content
    if (!Array.isArray(content)) continue
    if (content.some(block => (block as { type?: string }).type === 'tool_use')) {
      count++
    }
  }
  return count
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
  const { tools, verbose, terminalSize, inProgressToolCallCount } = options
  const isTranscriptMode = options.isTranscriptMode === true
  const rows = displayRows(progressMessages)

  if (messagesOf(progressMessages).length === 0) {
    return <AgentFactsOrInitialising {...(options.toolUseID !== undefined ? { toolUseID: options.toolUseID } : {})} />
  }

  const callCount = inProgressToolCallCount ?? 1
  const rowBudget = callCount * CONDENSED_ROWS_PER_CALL + CONDENSED_ROWS_BASE
  if (!isTranscriptMode && terminalSize && terminalSize.rows < rowBudget) {
    const toolUseCount = rows.filter(row => {
      const content = row.data.message!.message.content
      return (
        Array.isArray(content) &&
        content.some(
          block => (block as { type?: string }).type === 'tool_use',
        )
      )
    }).length
    const tokens = latestTokenTotal(progressMessages)
    return (
      <MessageResponse height={1}>
        <Text dimColor>
          In progress… <Text bold>{pluralise(toolUseCount, 'tool use')}</Text>
          {tokens > 0 ? ` · ${formatTokens(tokens)} tokens` : ''}
          {' · '}
          <ExpandHint parens />
        </Text>
      </MessageResponse>
    )
  }

  const revealAll = isTranscriptMode || verbose
  const visible = revealAll ? rows : rows.slice(-VISIBLE_TAIL)
  const hiddenToolUseCount = revealAll ? 0 : hiddenAgentToolUses(progressMessages, tools)
  const lookups = buildSubagentLookups(
    messagesOf(progressMessages).map(row => row.data.message!) as never,
  )

  const firstPrompt = (progressMessages[0] as { data?: AgentProgressData })
    ?.data?.prompt

  if (visible.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Initializing agent…</Text>
      </MessageResponse>
    )
  }

  return (
    <Box flexDirection="column">
      {isTranscriptMode && firstPrompt ? (
        <MessageResponse>
          <AgentPromptDisplay prompt={firstPrompt} />
        </MessageResponse>
      ) : null}
      {hiddenToolUseCount > 0 ? (
        <Text dimColor>
          +{pluralise(hiddenToolUseCount, 'more tool use')} <CtrlOToExpand />
        </Text>
      ) : null}
      <SubAgentProvider>
        {visible.map((row, index) => (
          <MessageResponse key={index}>
            <MessageComponent
              message={row.data.message as never}
              tools={tools}
              commands={[] as never}
              verbose={false}
              addMargin={false}
              shouldAnimate={false}
              shouldShowDot={false}
              isTranscriptMode={false}
              isStatic={true}
              inProgressToolUseIDs={EMPTY_SET}
              progressMessagesForMessage={[] as never}
              lookups={lookups as never}
            />
          </MessageResponse>
        ))}
      </SubAgentProvider>
    </Box>
  )
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
  const { tools, verbose } = options
  const isTranscriptMode = options.isTranscriptMode === true
  const record = data as AgentToolOutput & {
    status?: string
    prompt?: string
    content?: Array<{ type: 'text'; text: string }>
    error?: string
    totalToolUseCount?: number
    totalTokens?: number
    totalDurationMs?: number
  }
  const content = record.content

  if (record.status === 'async_launched') {
    const prompt = record.prompt
    return (
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>Agent launched in the background</Text>
        </MessageResponse>
        {!isTranscriptMode ? (
          <Byline>
            <KeyboardShortcutHint shortcut="↓" action="manage" />
            {prompt ? <ExpandHint /> : null}
          </Byline>
        ) : null}
        {isTranscriptMode && prompt ? (
          <MessageResponse>
            <AgentPromptDisplay prompt={prompt} />
          </MessageResponse>
        ) : null}
      </Box>
    )
  }

  if (record.status === 'completed' || record.status === 'failed') {
    const failed = record.status === 'failed'
    const result = [
      pluralise(record.totalToolUseCount ?? 0, 'tool use'),
      ...(typeof record.totalTokens === 'number' && record.totalTokens > 0
        ? [`${formatTokens(record.totalTokens)} tokens`]
        : []),
      formatDuration(record.totalDurationMs ?? 0),
    ]
    const stats = result.join(' · ')
    const rows = messagesOf(progressMessages).map(row => row.data.message!)
    const lookups = buildSubagentLookups(rows as never)
    return (
      <Box flexDirection="column">
        {isTranscriptMode && record.prompt ? (
          <MessageResponse>
            <AgentPromptDisplay prompt={record.prompt} />
          </MessageResponse>
        ) : null}
        {isTranscriptMode && rows.length > 0 ? (
          <SubAgentProvider>
            {rows
              .filter(message => message.type !== 'user')
              .map((message, index) => (
                <MessageResponse key={index}>
                  <MessageComponent
                    message={message as never}
                    tools={tools}
                    commands={[] as never}
                    verbose={false}
                    addMargin={false}
                    shouldAnimate={false}
                    shouldShowDot={false}
                    isTranscriptMode={true}
                    isStatic={true}
                    inProgressToolUseIDs={EMPTY_SET}
                    progressMessagesForMessage={[] as never}
                    lookups={lookups as never}
                  />
                </MessageResponse>
              ))}
          </SubAgentProvider>
        ) : null}
        {(isTranscriptMode || verbose) && content && content.length > 0 ? (
          <MessageResponse>
            <AgentResponseDisplay content={content} />
          </MessageResponse>
        ) : null}
        {failed ? (
          <MessageResponse height={1}>
            <Text color="red">
              {`Failed (${result.join(' · ')}) — ${data.error}`}
            </Text>
          </MessageResponse>
        ) : (
          <MessageResponse height={1}>
            <Text>Done ({stats})</Text>
          </MessageResponse>
        )}
        {!failed && !isTranscriptMode && !verbose && isResultTruncated(data) ? (
          <Box marginLeft={2}>
            <Text dimColor>
              <CtrlOToExpand />
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  }

  return null
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
            tools: options?.tools ?? ([] as never),
            verbose: options?.verbose ?? false,
            isTranscriptMode: options?.isTranscriptMode,
          })
        : null}
      <FallbackToolUseRejectedMessage />
    </Box>
  )
}

export function renderToolUseErrorMessage(
  result?: unknown,
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
            tools: options?.tools ?? ([] as never),
            verbose: options?.verbose ?? false,
            isTranscriptMode: options?.isTranscriptMode,
          })
        : null}
      <FallbackToolUseErrorMessage
        result={result as never}
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
    } catch {
      return {}
    }
  }
  return raw
}

export function extractLastToolInfo(
  progressMessages: readonly ProgressMessage[],
  tools: Tools,
): string | null {
  const rows = messagesOf(progressMessages)
  const toolUseById = new Map<string, { name: string; input: unknown }>()
  for (const row of rows) {
    const content = row.data.message!.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const typed = block as {
        type?: string
        id?: string
        name?: string
        input?: unknown
      }
      if (typed.type === 'tool_use' && typed.id && typed.name) {
        toolUseById.set(typed.id, { name: typed.name, input: typed.input })
      }
    }
  }
  let trailingSearchReads = 0
  outer: for (let i = rows.length - 1; i >= 0; i--) {
    const message = rows[i]!.data.message!
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const typed = block as { type?: string; tool_use_id?: string }
      if (typed.type !== 'tool_result' || !typed.tool_use_id) continue
      const use = toolUseById.get(typed.tool_use_id)
      const tool = use ? tools.find(t => t.name === use.name) : undefined
      const classification = use
        ? safeSearchOrReadClassification(tool, use.input)
        : undefined
      if (classification?.isSearch || classification?.isRead) {
        trailingSearchReads++
      } else {
        break outer
      }
    }
  }
  if (trailingSearchReads >= 2) {
    return `Searching and reading (${trailingSearchReads} operations)`
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const message = rows[i]!.data.message!
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const typed = block as { type?: string; tool_use_id?: string }
      if (typed.type !== 'tool_result' || !typed.tool_use_id) continue
      const use = toolUseById.get(typed.tool_use_id)
      if (!use) continue
      const tool = tools.find(t => t.name === use.name)
      if (!tool) return use.name
      let summary: string | null | undefined
      try {
        summary = tool.getToolUseSummary?.(use.input as never)
      } catch {
        summary = undefined
      }
      const label = safeUserFacingName(tool, use.input) || use.name
      return summary ? `${label}: ${summary}` : label
    }
  }
  return null
}

type GroupedEntry = {
  toolUseID?: string
  input: AgentUiInput
  toolUseCount: number
  tokens: number
  lastTool: string | null
  output?: { totalToolUseCount?: number; totalTokens?: number }
  isTeammateSpawn: boolean
  resolved: boolean
  isErrored: boolean
}

function factsForEntry(agents: readonly CrewAgentFacts[], entry: GroupedEntry): CrewAgentFacts | null {
  if (entry.toolUseID !== undefined) {
    const byId = crewAgentByToolUse(agents, entry.toolUseID)
    if (byId !== null) return byId
  }
  if (entry.isTeammateSpawn && entry.input.name) return crewAgentByName(agents, entry.input.name)
  return null
}

function factsStatusLine(facts: CrewAgentFacts, nowMs: number): string {
  const doing = facts.running ? (facts.activity ?? crewStateLabel(facts)) : crewStateLabel(facts)
  return `${doing} · ${crewElapsedLabel(facts, nowMs)}`
}

function CrewAgentRows({ entries, animate }: { entries: GroupedEntry[]; animate: boolean }): React.ReactNode {
  const roster = useFocusedWorkRoster()
  const agents = React.useMemo(() => crewAgentsOf(roster.rows, null), [roster])
  const now = useNowTick(animate ? 1000 : null)
  return (
    <>
      {entries.map((entry, index) => {
        const facts = factsForEntry(agents, entry)
        const resolved = entry.resolved || (facts !== null && !facts.running)
        const receiptTokens = (entry.output?.totalTokens ?? 0) > 0 ? entry.output!.totalTokens : undefined
        const tokens = facts !== null ? facts.tokens?.total : (receiptTokens ?? (entry.tokens > 0 ? entry.tokens : undefined))
        const toolUses = facts?.toolUses ?? entry.output?.totalToolUseCount ?? entry.toolUseCount
        const statusLine = facts !== null ? factsStatusLine(facts, now) : null
        return (
          <AgentProgressLine
            key={entry.toolUseID ?? index}
            agentType={userFacingName(entry.input)}
            {...(entry.isTeammateSpawn && entry.input.name ? { name: `@${entry.input.name}` } : {})}
            {...(entry.input.description !== undefined ? { description: entry.input.description } : {})}
            {...(entry.input.subagent_type ? { color: getAgentColor(entry.input.subagent_type) } : {})}
            {...(facts !== null ? { model: crewModelLabel(facts) } : {})}
            {...(statusLine !== null ? { statusLine } : {})}
            {...(statusLine === null && entry.lastTool !== null ? { lastToolInfo: entry.lastTool } : {})}
            toolUseCount={toolUses}
            {...(tokens !== undefined ? { tokens } : {})}
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
        <Text dimColor>Initializing agent…</Text>
      </MessageResponse>
    )
  }
  const parts = [
    crewModelLabel(facts),
    crewStateLabel(facts),
    crewToolUsesLabel(facts) ?? undefined,
    crewTokensLabel(facts) ?? undefined,
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
  const { shouldAnimate, tools } = options
  const entries = toolUses.map(entry => {
    const input = parseGroupInput(entry)
    const progress = entry.progressMessages ?? []
    let toolUseCount = 0
    for (const row of messagesOf(progress)) {
      const message = row.data.message!
      if (message.type !== 'user') continue
      const content = message.message.content
      if (
        Array.isArray(content) &&
        content.some(
          block => (block as { type?: string }).type === 'tool_result',
        )
      ) {
        toolUseCount++
      }
    }
    const tokens = latestTokenTotal(progress)
    const lastTool = extractLastToolInfo(progress, tools)
    const output = groupOutput(entry) as { status?: string; totalToolUseCount?: number; totalTokens?: number } | undefined
    const status = output?.status
    const isTeammateSpawn = Boolean(input.name && input.team_name)
    const isBackground =
      input.run_in_background === true ||
      status === 'async_launched' ||
      isTeammateSpawn
    const resolved = entry.isResolved === true || status !== undefined
    return {
      toolUseID: groupToolUseId(entry),
      input,
      toolUseCount,
      tokens,
      lastTool,
      ...(output !== undefined ? { output } : {}),
      status,
      isTeammateSpawn,
      isBackground,
      resolved,
      isErrored: entry.isErrored === true || status === 'failed',
    }
  })

  const allResolved = entries.every(entry => entry.resolved)
  const allBackground = entries.length > 0 && entries.every(entry => entry.isBackground)
  const anyErrored = entries.some(entry => entry.isErrored)
  const types = entries.map(entry => userFacingName(entry.input))
  const commonType =
    types.length > 0 &&
    types.every(type => type === types[0]) &&
    types[0] !== GENERIC_AGENT_LABEL
      ? types[0]
      : undefined

  let header: string
  if (allResolved && allBackground) {
    header = `${entries.length} background agents launched `
  } else if (allResolved) {
    header = commonType
      ? `${entries.length} ${commonType} agents finished`
      : `${entries.length} agents finished`
  } else {
    header = commonType
      ? `Running ${entries.length} ${commonType} agents…`
      : `Running ${entries.length} agents…`
  }

  const showExpandHint = !allBackground
  const animate = shouldAnimate && !allResolved

  return (
    <Box flexDirection="column">
      <Box>
        <ToolUseLoader
          shouldAnimate={animate}
          isUnresolved={!allResolved}
          isError={anyErrored}
        />
        <Text>
          {header}
          {allResolved && allBackground ? (
            <Text dimColor>
              <KeyboardShortcutHint shortcut="↓" action="manage" parens />
            </Text>
          ) : null}
          {showExpandHint ? (
            <Text dimColor>
              {' '}
              <CtrlOToExpand />
            </Text>
          ) : null}
        </Text>
      </Box>
      <CrewAgentRows entries={entries} animate={animate} />
    </Box>
  )
}
