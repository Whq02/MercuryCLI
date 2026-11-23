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
import type { Progress, Tools } from '../../Tool.js'
import { safeSearchOrReadClassification, safeUserFacingName } from '../../Tool.js'
import { buildSubagentLookups } from '../../services/messages.js'
import { formatTokens } from '../../utils/format.js'
import { getTokenCountFromUsage } from '../../services/context/tokens.js'
import type { ToolResultBlockParam } from '../../types/wire.js'
import type { AgentToolProgress, SkillToolProgress } from '../../types/tools.js'
import { isRecord } from '../../utils/isRecord.js'
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

type AgentOrSkillProgress = AgentToolProgress | SkillToolProgress

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

function agentProgressDataOf(
  progress: ProgressMessage | undefined,
): AgentOrSkillProgress | undefined {
  const data: Progress | undefined = progress?.data
  if (data === undefined) return undefined
  if (data.type === 'agent_progress' || data.type === 'skill_progress') {
    return data
  }
  return undefined
}

function messagesOf(progressMessages: readonly ProgressMessage[]): Array<{
  progress: ProgressMessage
  data: AgentOrSkillProgress
}> {
  const rows: Array<{ progress: ProgressMessage; data: AgentOrSkillProgress }> =
    []
  for (const progress of progressMessages) {
    const data = agentProgressDataOf(progress)
    if (data === undefined || !data.message) continue
    rows.push({ progress, data })
  }
  return rows
}

function displayRows(progressMessages: readonly ProgressMessage[]) {
  return messagesOf(progressMessages).filter(
    row => row.data.message.type !== 'user',
  )
}

function latestTokenTotal(
  progressMessages: readonly ProgressMessage[],
): number {
  for (let i = progressMessages.length - 1; i >= 0; i--) {
    const data = agentProgressDataOf(progressMessages[i])
    const message = data?.message
    if (!message || message.type !== 'assistant') continue
    const usage = message.message.usage
    if (!usage) continue
    return getTokenCountFromUsage(usage)
  }
  return 0
}


function AgentPromptDisplay({
  prompt,
}: {
  prompt: string
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold>Prompt:</Text>
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
  const type = input?.crewmate_type
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
    if (model === getEngineModel()) return null
    return <Text dimColor>{renderModelName(model)}</Text>
  } catch (error) {
    passedOver(error)
    return null
  }
}

function hasToolUseBlock(
  message: AssistantMessage | NormalizedUserMessage,
): boolean {
  if (message.type !== 'assistant') return false
  const content = message.message.content
  return Array.isArray(content) && content.some(block => block.type === 'tool_use')
}

function countAssistantToolUses(
  rows: ReadonlyArray<{ data: AgentOrSkillProgress }>,
): number {
  let count = 0
  for (const row of rows) {
    if (row.data.message.type !== 'assistant') continue
    const content = row.data.message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') count++
    }
  }
  return count
}

function firstProgressPrompt(
  progressMessages: readonly ProgressMessage[],
): string | undefined {
  const data = agentProgressDataOf(progressMessages[0])
  return typeof data?.prompt === 'string' && data.prompt !== ''
    ? data.prompt
    : undefined
}

export function hiddenAgentToolUses(
  progressMessages: readonly ProgressMessage[],
  tools: Tools,
): number {
  void tools
  const rows = displayRows(progressMessages)
  if (rows.length <= VISIBLE_TAIL) return 0
  return rows
    .slice(0, rows.length - VISIBLE_TAIL)
    .filter(row => hasToolUseBlock(row.data.message)).length
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
  const allMessages = messagesOf(progressMessages)
  if (allMessages.length === 0) {
    return (
      <AgentFactsOrInitialising
        {...(options.toolUseID !== undefined
          ? { toolUseID: options.toolUseID }
          : {})}
      />
    )
  }

  const condensedThreshold =
    (options.inProgressToolCallCount ?? 1) * CONDENSED_ROWS_PER_CALL +
    CONDENSED_ROWS_BASE
  if (
    !options.isTranscriptMode &&
    options.terminalSize !== undefined &&
    options.terminalSize.rows < condensedThreshold
  ) {
    const toolUseCount = countAssistantToolUses(allMessages)
    const tokens = latestTokenTotal(progressMessages)
    return (
      <MessageResponse height={1}>
        <Text dimColor>
          <Text bold>
            In progress… {pluralise(toolUseCount, 'tool use')}
          </Text>
          {tokens > 0 ? ` · ${formatTokens(tokens)} context` : null}
          {' · '}
          <ExpandHint parens />
        </Text>
      </MessageResponse>
    )
  }

  const allDisplay = displayRows(progressMessages)
  const showAll = Boolean(options.isTranscriptMode || options.verbose)
  const visible = showAll ? allDisplay : allDisplay.slice(-VISIBLE_TAIL)
  const hiddenToolUseCount = showAll
    ? 0
    : hiddenAgentToolUses(progressMessages, options.tools)

  if (visible.length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Initializing crewmate…</Text>
      </MessageResponse>
    )
  }

  const prompt = options.isTranscriptMode
    ? firstProgressPrompt(progressMessages)
    : undefined
  const { lookups, inProgressToolUseIDs } = buildSubagentLookups(
    allMessages.map(row => ({ message: row.data.message })),
  )

  return (
    <MessageResponse>
      <Box flexDirection="column">
        {prompt !== undefined ? <AgentPromptDisplay prompt={prompt} /> : null}
        {hiddenToolUseCount > 0 ? (
          <Text dimColor>
            +{pluralise(hiddenToolUseCount, 'more tool use')}{' '}
            <CtrlOToExpand />
          </Text>
        ) : null}
        <SubAgentProvider>
          {visible.map((row, index) => (
            <MessageComponent
              key={row.progress.uuid ?? index}
              message={row.data.message}
              tools={options.tools}
              commands={[]}
              verbose={false}
              addMargin={false}
              shouldAnimate={false}
              shouldShowDot={false}
              inProgressToolUseIDs={inProgressToolUseIDs}
              progressMessagesForMessage={[]}
              isTranscriptMode={false}
              isStatic={true}
              lookups={lookups}
            />
          ))}
        </SubAgentProvider>
      </Box>
    </MessageResponse>
  )
}

const EMPTY_SET: Set<string> = new Set()

export function isResultTruncated(data: AgentToolOutput): boolean {
  if (data.status !== 'completed' && data.status !== 'failed') {
    return false
  }
  return (
    Array.isArray(data.content) &&
    data.content.some(block => (block.text ?? '').trim() !== '')
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
  if (data.status === 'async_launched') {
    const prompt =
      typeof data.prompt === 'string' && data.prompt !== ''
        ? data.prompt
        : undefined
    return (
      <MessageResponse>
        <Box flexDirection="column">
          <Text>Crewmate launched in the background</Text>
          {options.isTranscriptMode ? (
            prompt !== undefined ? (
              <Box marginTop={1}>
                <AgentPromptDisplay prompt={prompt} />
              </Box>
            ) : null
          ) : (
            <Box>
              <Text dimColor>
                <Byline>
                  <KeyboardShortcutHint shortcut="↓" action="manage" />
                  {prompt !== undefined ? <ExpandHint /> : null}
                </Byline>
              </Text>
            </Box>
          )}
        </Box>
      </MessageResponse>
    )
  }

  if (data.status !== 'completed' && data.status !== 'failed') {
    return null
  }

  const stats: string[] = [pluralise(data.totalToolUseCount ?? 0, 'tool use')]
  const contextTokens = data.usage
    ? getTokenCountFromUsage({
        ...data.usage,
        inference_geo: null,
        iterations: null,
        output_tokens_details: null,
        speed: null,
      })
    : 0
  if (contextTokens > 0) {
    stats.push(`${formatTokens(contextTokens)} context`)
  }
  if (data.totalTokens !== undefined && data.totalTokens > 0) {
    stats.push(`${formatTokens(data.totalTokens)} spent`)
  }
  if (data.totalDurationMs !== undefined) {
    stats.push(formatDuration(data.totalDurationMs))
  }
  const statsText = stats.join(' · ')

  const prompt =
    typeof data.prompt === 'string' && data.prompt !== ''
      ? data.prompt
      : firstProgressPrompt(progressMessages)
  const allMessages = messagesOf(progressMessages)
  const transcriptRows = options.isTranscriptMode
    ? displayRows(progressMessages)
    : []
  const transcriptLookups =
    transcriptRows.length > 0
      ? buildSubagentLookups(
          allMessages.map(row => ({ message: row.data.message })),
        ).lookups
      : null
  const textBlocks = (data.content ?? []).filter(
    block => block.type === 'text' && block.text.trim() !== '',
  )
  const showExpandHint =
    data.status === 'completed' &&
    !options.isTranscriptMode &&
    !options.verbose &&
    isResultTruncated(data)

  return (
    <MessageResponse>
      <Box flexDirection="column">
        {options.isTranscriptMode && prompt !== undefined ? (
          <AgentPromptDisplay prompt={prompt} />
        ) : null}
        {transcriptLookups !== null ? (
          <SubAgentProvider>
            {transcriptRows.map((row, index) => (
              <MessageComponent
                key={row.progress.uuid ?? index}
                message={row.data.message}
                tools={options.tools}
                commands={[]}
                verbose={false}
                addMargin={false}
                shouldAnimate={false}
                shouldShowDot={false}
                inProgressToolUseIDs={EMPTY_SET}
                progressMessagesForMessage={[]}
                isTranscriptMode={false}
                isStatic={true}
                lookups={transcriptLookups}
              />
            ))}
          </SubAgentProvider>
        ) : null}
        {(options.isTranscriptMode || options.verbose) &&
        textBlocks.length > 0 ? (
          <AgentResponseDisplay content={textBlocks} />
        ) : null}
        {data.status === 'failed' ? (
          <Text color="error">
            Failed ({statsText})
            {data.error ? ` — ${data.error}` : ''}
          </Text>
        ) : (
          <Text>Done ({statsText})</Text>
        )}
        {showExpandHint ? (
          <Box marginLeft={2}>
            <Text dimColor>
              <CtrlOToExpand />
            </Text>
          </Box>
        ) : null}
      </Box>
    </MessageResponse>
  )
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

type GroupOutputSummary = {
  status?: string
  totalToolUseCount?: number
  totalTokens?: number
}

function groupOutput(entry: GroupedToolUse): GroupOutputSummary | undefined {
  const raw = entry.output ?? entry.rawResult
  if (!isRecord(raw)) return undefined
  return {
    ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
    ...(typeof raw.totalToolUseCount === 'number'
      ? { totalToolUseCount: raw.totalToolUseCount }
      : {}),
    ...(typeof raw.totalTokens === 'number' ? { totalTokens: raw.totalTokens } : {}),
  }
}

function parseAgentUiInput(value: unknown): AgentUiInput {
  if (!isRecord(value)) return {}
  return {
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
    ...(typeof value.crewmate_type === 'string'
      ? { crewmate_type: value.crewmate_type }
      : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.run_in_background === 'boolean'
      ? { run_in_background: value.run_in_background }
      : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
  }
}

function parseGroupInput(entry: GroupedToolUse): AgentUiInput {
  const raw: unknown = entry.input ?? entry.toolUse?.input
  if (typeof raw === 'string') {
    try {
      return parseAgentUiInput(JSON.parse(raw))
    } catch (error) {
      passedOver(error)
      return {}
    }
  }
  return parseAgentUiInput(raw)
}

type GroupedEntry = {
  toolUseID?: string
  input: AgentUiInput
  toolUseCount: number
  tokens: number
  lastTool: string | null
  output?: GroupOutputSummary
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

function isSearchOrReadCall(
  tools: Tools,
  call: { name: string; input: unknown },
): boolean {
  const tool = tools.find(t => t.name === call.name)
  const classification = safeSearchOrReadClassification(tool, call.input)
  return Boolean(
    classification?.isSearch ||
      classification?.isRead ||
      classification?.isList,
  )
}

function summarizeLastTool(
  allMessages: ReadonlyArray<{ data: AgentOrSkillProgress }>,
  tools: Tools,
): string | null {
  const toolUsesById = new Map<string, { name: string; input: unknown }>()
  const allToolUses: Array<{ name: string; input: unknown }> = []
  const completedCalls: Array<{ name: string; input: unknown }> = []

  for (const row of allMessages) {
    const message = row.data.message
    const content = message.message.content
    if (!Array.isArray(content)) continue
    if (message.type === 'assistant') {
      for (const block of content) {
        if (block.type === 'tool_use') {
          const call = { name: block.name, input: block.input }
          toolUsesById.set(block.id, call)
          allToolUses.push(call)
        }
      }
      continue
    }
    for (const block of content) {
      if (typeof block !== 'string' && block.type === 'tool_result') {
        const matched = toolUsesById.get(block.tool_use_id)
        if (matched) completedCalls.push(matched)
      }
    }
  }

  let trailingSearchRead = 0
  for (let i = completedCalls.length - 1; i >= 0; i--) {
    if (isSearchOrReadCall(tools, completedCalls[i]!)) {
      trailingSearchRead++
    } else {
      break
    }
  }
  if (trailingSearchRead >= 2) {
    return `Searching and reading (${trailingSearchRead} operations)`
  }

  const lastCall = completedCalls.at(-1) ?? allToolUses.at(-1)
  if (!lastCall) return null
  const tool = tools.find(t => t.name === lastCall.name)
  const name = tool ? safeUserFacingName(tool, lastCall.input) : lastCall.name
  let summary: string | null = null
  if (tool?.getToolUseSummary) {
    try {
      summary = tool.getToolUseSummary(lastCall.input)
    } catch (error) {
      passedOver(error)
    }
  }
  return summary ? `${name}: ${summary}` : name
}

function countToolResultRows(
  allMessages: ReadonlyArray<{ data: AgentOrSkillProgress }>,
): number {
  let count = 0
  for (const row of allMessages) {
    if (row.data.message.type !== 'user') continue
    const content = row.data.message.message.content
    if (
      Array.isArray(content) &&
      content.some(block => typeof block !== 'string' && block.type === 'tool_result')
    ) {
      count++
    }
  }
  return count
}

export function renderGroupedAgentToolUse(
  toolUses: GroupedToolUse[],
  options: { shouldAnimate: boolean; tools: Tools },
): React.ReactNode {
  const analyzed = toolUses.map(raw => {
    const input = parseGroupInput(raw)
    const progress = raw.progressMessages ?? []
    const allMsgs = messagesOf(progress)
    const output = groupOutput(raw)
    const isBackground = Boolean(
      input.run_in_background || output?.status === 'async_launched',
    )
    const resolved = Boolean(raw.isResolved || output !== undefined)
    const isErrored = Boolean(raw.isErrored || output?.status === 'failed')
    const isDenied = Boolean(raw.isDenied)
    const entry: GroupedEntry = {
      toolUseID: groupToolUseId(raw),
      input,
      toolUseCount: countToolResultRows(allMsgs),
      tokens: latestTokenTotal(progress),
      lastTool: summarizeLastTool(allMsgs, options.tools),
      output,
      resolved,
      isErrored,
    }
    return { entry, isBackground, isDenied }
  })

  const entries = analyzed.map(item => item.entry)
  const allResolved =
    analyzed.length > 0 && analyzed.every(item => item.entry.resolved)
  const allBackground =
    analyzed.length > 0 && analyzed.every(item => item.isBackground)
  const anyErrored = analyzed.some(item => item.entry.isErrored)
  const anyDenied = analyzed.some(item => item.isDenied)

  const names = entries.map(entry => userFacingName(entry.input))
  const firstName = names[0]
  const commonType =
    firstName !== undefined &&
    firstName !== GENERIC_AGENT_LABEL &&
    names.every(name => name === firstName)
      ? firstName
      : null

  const headerText = allResolved
    ? commonType !== null
      ? `${entries.length} ${commonType} crewmates finished`
      : `${entries.length} crewmates finished`
    : commonType !== null
      ? `Running ${entries.length} ${commonType} crewmates…`
      : `Running ${entries.length} crewmates…`

  return (
    <Box flexDirection="column">
      <Box>
        <ToolRowLead
          family="agent"
          state={toolRowStateOf({
            resolved: allResolved,
            errored: anyErrored,
            denied: anyDenied,
          })}
        />
        {allResolved && allBackground ? (
          <>
            <Text bold>{entries.length} background crewmates launched </Text>
            <Text dimColor>
              <KeyboardShortcutHint shortcut="↓" action="manage" parens />
            </Text>
          </>
        ) : (
          <Text>
            <Text bold>{headerText}</Text>
            {!allBackground ? (
              <>
                {' '}
                <CtrlOToExpand />
              </>
            ) : null}
          </Text>
        )}
      </Box>
      <CrewAgentRows
        entries={entries}
        animate={options.shouldAnimate && !allResolved}
      />
    </Box>
  )
}
