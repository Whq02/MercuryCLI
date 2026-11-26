import * as React from 'react'
import { Box, Text } from '../../screen/themedRenderer.js'
import { CrewmateProgressLine } from './CrewmateProgressLine.js'
import { ConfigurableShortcutHint } from '../../screen/keys/ConfigurableShortcutHint.js'
import { CtrlOToExpand, NestedRowsProvider } from '../../screen/messages/CtrlOToExpand.js'
import { Byline } from '../../screen/theme/Byline.js'
import { KeyboardShortcutHint } from '../../screen/theme/KeyboardShortcutHint.js'
import { Message as MessageComponent } from '../../screen/messages/Message.js'
import { MessageResponse } from '../kit/MessageResponse.js'
import { FallbackToolUseErrorMessage } from '../kit/FallbackToolUseErrorMessage.js'
import { FallbackToolUseRejectedMessage } from '../kit/FallbackToolUseRejectedMessage.js'
import { ToolRowLead, toolRowStateOf } from '../../screen/messages/ToolRowLead.js'
import type {
  AssistantMessage,
  NormalizedUserMessage,
  ProgressMessage,
} from '../../engine/message-shapes/message.js'
import type { Tools } from '../kit/tool.js'
import { safeSearchOrReadClassification, safeUserFacingName } from '../kit/tool.js'
import { buildNestedLookups } from '../../engine/messages/messages.js'
import { formatTokens } from '../../platform/text/format.js'
import { getTokenCountFromUsage } from '../../engine/context-window/contextTokenCount.js'
import type { ApiUsage, ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import { isRecord } from '../../platform/primitives/isRecord.js'
import { renderModelName, getEngineModel } from '../../models/catalogue/engineModel.js'
import { Markdown } from '../../screen/messages/Markdown.js'
import { getAgentColor } from './agentColors.js'
import { useNowTick } from '../../screen/widgets/components.js'
import { useSessionCrew } from '../../screen/tasks/useCrewLedger.js'
import {
  crewmateByToolUse,
  crewModelLabel,
  crewPhaseWords,
  crewTimeWords,
  crewTokensSummary,
  type CrewmateFacts,
} from '../../engine/connector/crewFacts.js'
import type { CrewmateToolOutput } from './CrewmateTool.js'
import { passedOver } from '../../platform/errors/passedOver.js'

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

const GENERIC_CREWMATE_LABEL = 'crewmate'

type CrewmateProgressData = {
  type?: string
  message?: AssistantMessage | NormalizedUserMessage
  prompt?: string
  agentId?: string
}

type CrewmateUiInput = {
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

type CrewmateProgressDataWithMessage = CrewmateProgressData & {
  message: AssistantMessage | NormalizedUserMessage
}

function hasProgressMessage(
  data: CrewmateProgressData | undefined,
): data is CrewmateProgressDataWithMessage {
  return Boolean(data && data.message)
}

function messagesOf(progressMessages: readonly ProgressMessage[]): Array<{
  progress: ProgressMessage
  data: CrewmateProgressDataWithMessage
}> {
  const rows: Array<{ progress: ProgressMessage; data: CrewmateProgressDataWithMessage }> =
    []
  for (const progress of progressMessages) {
    const data = (progress as { data?: CrewmateProgressData }).data
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
    const data = (progressMessages[i] as { data?: CrewmateProgressData }).data
    const message = data?.message
    if (!message || message.type !== 'assistant') continue
    const usage = (message as AssistantMessage).message.usage
    if (!usage) continue
    return getTokenCountFromUsage(usage as ApiUsage)
  }
  return 0
}


function CrewmatePromptDisplay({
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

function CrewmateResponseDisplay({
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

export function userFacingName(input?: CrewmateUiInput): string {
  const type = input?.crewmate_type
  if (!type || type === 'mercury-crew' || type === 'worker') {
    return GENERIC_CREWMATE_LABEL
  }
  return type
}

export function userFacingNameBackgroundColor(
  input?: CrewmateUiInput,
): string | undefined {
  const type = input?.crewmate_type
  if (!type) return undefined
  return getAgentColor(type)
}

export function renderToolUseMessage(
  input?: CrewmateUiInput,
): React.ReactNode | string | null {
  if (!input?.description || !input?.prompt) return null
  return input.description
}

export function renderToolUseTag(
  input?: CrewmateUiInput,
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
  rows: ReadonlyArray<{ data: CrewmateProgressDataWithMessage }>,
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
  const data = progressMessages[0]?.data
  if (data?.type !== 'agent_progress' && data?.type !== 'skill_progress') {
    return undefined
  }
  return typeof data.prompt === 'string' && data.prompt !== ''
    ? data.prompt
    : undefined
}

export function hiddenCrewmateToolUses(
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
      <CrewmateFactsOrInitialising
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
    : hiddenCrewmateToolUses(progressMessages, options.tools)

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
  const { lookups, inProgressToolUseIDs } = buildNestedLookups(
    allMessages.map(row => ({ message: row.data.message })),
  )

  return (
    <MessageResponse>
      <Box flexDirection="column">
        {prompt !== undefined ? <CrewmatePromptDisplay prompt={prompt} /> : null}
        {hiddenToolUseCount > 0 ? (
          <Text dimColor>
            +{pluralise(hiddenToolUseCount, 'more tool use')}{' '}
            <CtrlOToExpand />
          </Text>
        ) : null}
        <NestedRowsProvider>
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
        </NestedRowsProvider>
      </Box>
    </MessageResponse>
  )
}

const EMPTY_SET: Set<string> = new Set()

export function isResultTruncated(data: CrewmateToolOutput): boolean {
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
  data: CrewmateToolOutput & { error?: string },
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
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>Crewmate launched in the background</Text>
        </MessageResponse>
        {!options.isTranscriptMode ? (
          <Byline>
            <KeyboardShortcutHint shortcut="↓" action="manage" />
            {prompt !== undefined ? <ExpandHint /> : null}
          </Byline>
        ) : null}
        {options.isTranscriptMode && prompt !== undefined ? (
          <MessageResponse>
            <CrewmatePromptDisplay prompt={prompt} />
          </MessageResponse>
        ) : null}
      </Box>
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
      ? buildNestedLookups(
          allMessages.map(row => ({ message: row.data.message })),
        ).lookups
      : null
  const showExpandHint =
    data.status === 'completed' &&
    !options.isTranscriptMode &&
    !options.verbose &&
    isResultTruncated(data)

  return (
    <Box flexDirection="column">
      {options.isTranscriptMode && prompt !== undefined ? (
        <MessageResponse>
          <CrewmatePromptDisplay prompt={prompt} />
        </MessageResponse>
      ) : null}
      {transcriptLookups !== null ? (
        <NestedRowsProvider>
          {transcriptRows.map((row, index) => (
            <MessageResponse key={index}>
              <MessageComponent
                message={row.data.message}
                tools={options.tools}
                commands={[]}
                verbose={false}
                addMargin={false}
                shouldAnimate={false}
                shouldShowDot={false}
                inProgressToolUseIDs={EMPTY_SET}
                progressMessagesForMessage={[]}
                isTranscriptMode={true}
                isStatic={true}
                lookups={transcriptLookups}
              />
            </MessageResponse>
          ))}
        </NestedRowsProvider>
      ) : null}
      {(options.isTranscriptMode || options.verbose) &&
      data.content &&
      data.content.length > 0 ? (
        <MessageResponse>
          <CrewmateResponseDisplay content={data.content} />
        </MessageResponse>
      ) : null}
      <MessageResponse height={1}>
        {data.status === 'failed' ? (
          <Text color="red">
            Failed ({statsText}) — {data.error}
          </Text>
        ) : (
          <Text>Done ({statsText})</Text>
        )}
      </MessageResponse>
      {showExpandHint ? (
        <Box marginLeft={2}>
          <Text dimColor>
            <CtrlOToExpand />
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

export function renderToolUseRejectedMessage(
  input?: CrewmateUiInput,
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
  input?: CrewmateUiInput | string
  progressMessages?: ProgressMessage[]
  output?: CrewmateToolOutput | { status?: string }
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

function parseGroupInput(entry: GroupedToolUse): CrewmateUiInput {
  const raw = entry.input ?? (entry.toolUse?.input as CrewmateUiInput | string | undefined)
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as CrewmateUiInput
    } catch (error) {
      passedOver(error)
      return {}
    }
  }
  return raw
}

type GroupedEntry = {
  toolUseID?: string
  input: CrewmateUiInput
  tokens: number
  lastTool: string | null
  output?: { totalTokens?: number }
  resolved: boolean
  isErrored: boolean
}

function factsForEntry(agents: readonly CrewmateFacts[], entry: GroupedEntry): CrewmateFacts | null {
  if (entry.toolUseID === undefined) return null
  return crewmateByToolUse(agents, entry.toolUseID)
}

function CrewmateRows({ entries, animate }: { entries: GroupedEntry[]; animate: boolean }): React.ReactNode {
  const crewRows = useSessionCrew()
  const agents = React.useMemo(() => crewRows.map(row => row.facts), [crewRows])
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
            ? crewTokensSummary(facts)
            : receiptTokens !== undefined
              ? `${formatTokens(receiptTokens)} spent`
              : entry.tokens > 0
                ? `${formatTokens(entry.tokens)} context`
                : undefined
        const statusLine = facts !== null ? crewPhaseWords(facts, now) : null
        return (
          <CrewmateProgressLine
            key={entry.toolUseID ?? index}
            agentType={userFacingName(entry.input)}
            {...(entry.input.description !== undefined ? { description: entry.input.description } : {})}
            {...(entry.input.crewmate_type ? { color: getAgentColor(entry.input.crewmate_type) } : {})}
            {...(facts !== null ? { model: crewModelLabel(facts), timeWords: crewTimeWords(facts, now) } : {})}
            {...(statusLine !== null ? { statusLine } : {})}
            {...(facts === null && entry.lastTool !== null ? { lastToolInfo: entry.lastTool } : {})}
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

function CrewmateFactsOrInitialising({ toolUseID }: { toolUseID?: string }): React.ReactNode {
  const crewRows = useSessionCrew()
  const facts = React.useMemo(
    () => (toolUseID === undefined ? null : crewmateByToolUse(crewRows.map(row => row.facts), toolUseID)),
    [crewRows, toolUseID],
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
    crewTimeWords(facts, now),
    crewTokensSummary(facts),
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
  allMessages: ReadonlyArray<{ data: CrewmateProgressDataWithMessage }>,
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

export function renderGroupedCrewmateToolUse(
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
    const rawOutput: unknown = raw.output ?? raw.rawResult
    const outputMetrics = isRecord(rawOutput)
      ? {
          ...(typeof rawOutput.totalTokens === 'number'
            ? { totalTokens: rawOutput.totalTokens }
            : {}),
        }
      : undefined
    const entry: GroupedEntry = {
      toolUseID: groupToolUseId(raw),
      input,
      tokens: latestTokenTotal(progress),
      lastTool: summarizeLastTool(allMsgs, options.tools),
      output: outputMetrics,
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
    firstName !== GENERIC_CREWMATE_LABEL &&
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
      <CrewmateRows
        entries={entries}
        animate={options.shouldAnimate && !allResolved}
      />
    </Box>
  )
}
