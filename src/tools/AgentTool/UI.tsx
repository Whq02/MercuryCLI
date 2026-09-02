// Terminal rendering of agent tool use: live progress folds,
// grouped multi-agent rows, and completion rows. Mercury layers: the
// failed-outcome row renders honestly as a failure, and the click-to-expand
// fold accounting is the ONE exported math (prover-pinned lines below).

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
import type { AgentToolOutput } from './AgentTool.js'

/** The shared expand hint (transcript toggle), parenthesised where inline. */
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

// ── Formatting helpers ─────────────────────────────────────────────────────

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

/** Progress payloads carrying an attached message object — shell progress
 *  forwarded from the subagent has none and is ignored by the UI while
 * still flowing to the SDK. */
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

/** Display rows: user-message progress rows are dropped (a subagent's
 *  progress rows carry no tool result — the renderer would leave a blank
 *  row behind). */
function displayRows(progressMessages: readonly ProgressMessage[]) {
  return messagesOf(progressMessages).filter(
    row => row.data.message!.type !== 'user',
  )
}

/** Token total from the latest assistant progress message's usage, summed
 *  across cache-creation, cache-read, input, and output. */
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

// ── exports ─────────────────────────────────────────────────────────────

/** Bold labelled heading + markdown body indented two columns. */
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

/** The agent type; the default type and 'worker' display as the generic
 * label. */
export function userFacingName(input?: AgentUiInput): string {
  const type = input?.subagent_type
  if (!type || type === 'general-purpose' || type === 'worker') {
    return GENERIC_AGENT_LABEL
  }
  return type
}

/** Background colour = the registered colour of the type; none without a
 *  type. */
export function userFacingNameBackgroundColor(
  input?: AgentUiInput,
): string | undefined {
  const type = input?.subagent_type
  if (!type) return undefined
  return getAgentColor(type)
}

/** Renders the description — only when both description and prompt exist. */
export function renderToolUseMessage(
  input?: AgentUiInput,
): React.ReactNode | string | null {
  if (!input?.description || !input?.prompt) return null
  return input.description
}

/** A dimmed rendered model name when an override differs from the current
 *  main-loop model; nothing otherwise. */
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

/**
 * The ONE exported fold math (prover-pinned): processed messages minus the
 * visible tail, counting messages that carry at least one tool-use block —
 * one message counts once regardless of how many blocks it holds, and a
 * message carrying only results or text never counts.
 */
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

/** Live progress fold. */
export function renderToolUseProgressMessage(
  progressMessages: readonly ProgressMessage[],
  options: {
    tools: Tools
    verbose: boolean
    terminalSize?: { columns: number; rows: number }
    inProgressToolCallCount?: number
    isTranscriptMode?: boolean
  },
): React.ReactNode {
  const { tools, verbose, terminalSize, inProgressToolCallCount } = options
  const isTranscriptMode = options.isTranscriptMode === true
  const rows = displayRows(progressMessages)

  if (messagesOf(progressMessages).length === 0) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>Initializing agent…</Text>
      </MessageResponse>
    )
  }

  // Condensed mode: short terminals get exactly one line. The default
  // in-progress count applies only when the count is ABSENT — an explicit
  // zero yields the bare buffer estimate.
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

  // Normal mode: last 3 processed messages, or ALL under transcript mode or
  // the row's effective verbose flag (global verbose OR click-expanded).
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

/** True exactly when the collapsed row hides a report worth revealing:
 * completed/failed with non-empty content. */
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

/** Result rendering. */
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
      // The token segment rides the card only when the child's wire reported
      // usage: carrier dialects that report none sum to 0 in the tracker,
      // and "0 tokens" would be an invented count, not a measurement.
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

/** Rejected / errored render the progress fold plus the shared fallback
 *  row — no terminal size and no in-progress count, so the condensed
 * branch never fires on these paths. */
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

// ── Grouped rendering ──────────────────────────────────────────────

type GroupedToolUse = {
  toolUseID?: string
  input?: AgentUiInput | string
  progressMessages?: ProgressMessage[]
  output?: AgentToolOutput | { status?: string }
  isResolved?: boolean
  isErrored?: boolean
}

function parseGroupInput(entry: GroupedToolUse): AgentUiInput {
  const raw = entry.input
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

/** Trailing consecutive search/read count and last-tool summary. */
export function extractLastToolInfo(
  progressMessages: readonly ProgressMessage[],
  tools: Tools,
): string | null {
  const rows = messagesOf(progressMessages)
  // Index every tool-use block seen in progress.
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
  // Count trailing consecutive search/read operations from the end,
  // counting only the RESULT messages (avoids double counting).
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
  // Otherwise: the last tool-result message resolves its tool use.
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

/** Grouped multi-agent row. */
export function renderGroupedAgentToolUse(
  toolUses: GroupedToolUse[],
  options: { shouldAnimate: boolean; tools: Tools },
): React.ReactNode {
  const { shouldAnimate, tools } = options
  const entries = toolUses.map(entry => {
    const input = parseGroupInput(entry)
    const progress = entry.progressMessages ?? []
    // Tool-use count from user messages containing tool results.
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
    const status = (entry.output as { status?: string } | undefined)?.status
    const isTeammateSpawn = Boolean(input.name && input.team_name)
    const isBackground =
      input.run_in_background === true ||
      status === 'async_launched' ||
      isTeammateSpawn
    const resolved = entry.isResolved === true || status !== undefined
    return {
      input,
      toolUseCount,
      tokens,
      lastTool,
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
      {entries.map((entry, index) => (
        <AgentProgressLine
          key={index}
          agentType={userFacingName(entry.input)}
          {...(entry.isTeammateSpawn && entry.input.name ? { name: `@${entry.input.name}` } : {})}
          {...(entry.input.description !== undefined ? { description: entry.input.description } : {})}
          {...(entry.input.subagent_type
            ? { color: getAgentColor(entry.input.subagent_type) }
            : {})}
          {...(entry.lastTool !== null ? { lastToolInfo: entry.lastTool } : {})}
          toolUseCount={entry.toolUseCount}
          tokens={entry.tokens}
          isLast={index === entries.length - 1}
          isResolved={entry.resolved}
          isError={entry.isErrored}
          shouldAnimate={animate}
        />
      ))}
    </Box>
  )
}
