
import React, { useRef } from 'react'
import { Text } from '../../ink.js'
import type {
  CollapsedReadSearchGroup,
} from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import { useMinDisplayTime } from '../../hooks/useMinDisplayTime.js'
import type { MessageLookups } from '../../services/messages/lookups.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { plural } from '../../utils/stringUtils.js'
import { toTildePath } from '../../utils/path.js'
import { useFluxMountMark } from '../../hooks/useFluxMountMark.js'
import {
  getEphemeralProgressFrame,
  useEphemeralProgressVersion,
} from '../../state/ephemeralProgressStore.js'
import { hookWaitLineOf } from '../../utils/hooks/wait.js'
import {
  firstRunningShellId,
  movedToBackgroundByOperator,
  type ToolUseEntryV1,
} from '../../services/engine-connector/shellRunning.js'
import type { ToolFamily } from '../mercury-ui/toolGlyphs.js'
import { useSelectedMessageBg } from '../messageActions.js'
import { collapsedGroupView, verboseGroupView, type Fragment } from './collapsedReadSearch/views.js'

const HINT_MIN_DISPLAY_MS = 700


function bold(n: number): React.ReactNode {
  return <Text bold>{n}</Text>
}

function counted(verb: string, n: number, noun: string, family: ToolFamily): Fragment {
  return {
    verb,
    family,
    rest: (
      <>
        {' '}
        {bold(n)} {plural(n, noun)}
      </>
    ),
  }
}

function memberResultText(lookups: MessageLookups, id: string): string {
  const holder = lookups.toolResultByToolUseID.get(id)
  const content = holder?.type === 'user' ? holder.message.content : undefined
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block.type !== 'tool_result' || block.tool_use_id !== id) continue
    if (typeof block.content === 'string') return block.content
    if (Array.isArray(block.content)) {
      return block.content.map(part => (part.type === 'text' ? part.text : '')).join('\n')
    }
  }
  return ''
}

function memberToolUses(group: CollapsedReadSearchGroup): ToolUseEntryV1[] {
  const entries: ToolUseEntryV1[] = []
  for (const member of group.messages) {
    if (member.type === 'grouped_tool_use') {
      for (const inner of member.messages) {
        const first = inner.message.content[0]
        if (first && first.type === 'tool_use') entries.push({ id: first.id, name: first.name })
      }
      continue
    }
    const first = member.message.content[0]
    if (first && first.type === 'tool_use') entries.push({ id: first.id, name: first.name })
  }
  return entries
}

export function CollapsedReadSearchContent({
  message,
  inProgressToolUseIDs,
  shouldAnimate = false,
  verbose = false,
  isTranscriptMode = false,
  tools,
  lookups,
  isActiveGroup = false,
}: {
  message: CollapsedReadSearchGroup
  inProgressToolUseIDs: Set<string>
  shouldAnimate?: boolean
  verbose?: boolean
  isTranscriptMode?: boolean
  tools: Tools
  lookups: MessageLookups
  isActiveGroup?: boolean
}): React.ReactNode {
  const fullscreen = isFullscreenEnvEnabled()
  const selectedBg = useSelectedMessageBg()
  const memberEntries = React.useMemo(() => memberToolUses(message), [message])
  const memberIds = React.useMemo(() => memberEntries.map(entry => entry.id), [memberEntries])
  useEphemeralProgressVersion(memberIds)
  useFluxMountMark('read-group')

  const latchRef = useRef({ read: 0, search: 0, list: 0, mcp: 0, bash: 0 })
  const latch = latchRef.current
  latch.read = Math.max(latch.read, message.readCount)
  latch.search = Math.max(latch.search, message.searchCount)
  latch.list = Math.max(latch.list, message.listCount)
  latch.mcp = Math.max(latch.mcp, message.mcpCallCount ?? 0)
  latch.bash = Math.max(latch.bash, fullscreen ? (message.bashCount ?? 0) : 0)
  const memoryReads = message.memoryReadCount
  const memorySearches = message.memorySearchCount
  const memoryWrites = message.memoryWriteCount
  const gitOps = fullscreen ? (message.gitOpBashCount ?? 0) : 0
  const bashCount = Math.max(0, latch.bash - gitOps)

  const anyErrored = memberIds.some(id => lookups.erroredToolUseIDs.has(id))
  const anyDenied = memberIds.some(id => lookups.deniedToolUseIDs.has(id))
  const deniedIds = React.useMemo(
    () => memberIds.filter(id => lookups.deniedToolUseIDs.has(id)),
    [memberIds, lookups.deniedToolUseIDs],
  )
  const runningIds = React.useMemo(
    () => memberIds.filter(id => inProgressToolUseIDs.has(id)),
    [memberIds, inProgressToolUseIDs],
  )
  const active = isActiveGroup && runningIds.length > 0
  const settledCount = Math.max(0, memberIds.length - runningIds.length)
  const bashDenied = Math.min(deniedIds.length, bashCount)
  const bashRan = Math.max(0, bashCount - bashDenied)
  const bashBlocked = Math.min(bashDenied, settledCount)
  const shellId = active && shouldAnimate && !isTranscriptMode ? firstRunningShellId(memberEntries, inProgressToolUseIDs) : null
  const movedByOperator = memberIds.some(id =>
    movedToBackgroundByOperator(
      (lookups.toolResultByToolUseID.get(id) as { toolUseResult?: unknown } | undefined)?.toolUseResult,
    ),
  )

  let rawHint: string | null = null
  if (active) {
    if (rawHint === null && message.latestDisplayHint) rawHint = message.latestDisplayHint
    if (rawHint === null && message.readFilePaths.length > 0) {
      rawHint = toTildePath(message.readFilePaths[message.readFilePaths.length - 1]!)
    }
    if (rawHint === null && message.searchArgs.length > 0) {
      rawHint = `"${message.searchArgs[message.searchArgs.length - 1]!}"`
    }
  }
  const hint = useMinDisplayTime(rawHint, HINT_MIN_DISPLAY_MS)

  const past = runningIds.length === 0
  const fragments: Fragment[] = []
  if (fullscreen) {
    for (const commit of message.commits ?? []) {
      const verb =
        commit.kind === 'amended'
          ? past
            ? 'amended'
            : 'amending'
          : commit.kind === 'cherry-picked'
            ? past
              ? 'cherry-picked'
              : 'cherry-picking'
            : past
              ? 'committed'
              : 'committing'
      fragments.push({
        verb,
        family: 'shell',
        rest: (
          <>
            {' '}
            <Text bold>{commit.sha.slice(0, 7)}</Text>
          </>
        ),
      })
    }
    for (const push of message.pushes ?? []) {
      fragments.push({
        verb: past ? 'pushed' : 'pushing',
        family: 'shell',
        rest: (
          <>
            {' '}
            <Text bold>{push.branch}</Text>
          </>
        ),
      })
    }
    for (const branch of message.branches ?? []) {
      const verb =
        branch.action === 'rebased'
          ? past
            ? 'rebased'
            : 'rebasing'
          : past
            ? 'merged'
            : 'merging'
      fragments.push({
        verb,
        family: 'shell',
        rest: (
          <>
            {' '}
            <Text bold>{branch.ref}</Text>
          </>
        ),
      })
    }
    for (const pr of message.prs ?? []) {
      const verb = past
        ? pr.action === 'created'
          ? 'opened'
          : pr.action
        : `${pr.action === 'created' ? 'opening' : `${pr.action.replace(/ed$/, '')}ing`}`
      fragments.push({
        verb: `${verb} PR`,
        family: 'shell',
        rest: (
          <>
            {' '}
            <Text bold>#{pr.number}</Text>
          </>
        ),
      })
    }
  }
  if (latch.search > 0) {
    fragments.push(counted(past ? 'searched for' : 'searching for', latch.search, 'pattern', 'search'))
  }
  if (latch.read > 0) {
    fragments.push(counted(past ? 'read' : 'reading', latch.read, 'file', 'read'))
  }
  if (latch.list > 0) {
    fragments.push(counted(past ? 'listed' : 'listing', latch.list, 'directory', 'search'))
  }
  if (latch.mcp > 0) {
    const servers = (message.mcpServerNames ?? []).map(name =>
      name.startsWith('claude.ai ') ? name.slice('claude.ai '.length) : name,
    )
    const label = servers.length > 0 ? servers.join(', ') : 'MCP'
    const countPart = latch.mcp > 1 ? ` ×${latch.mcp}` : ''
    void countPart
    fragments.push({
      verb: past ? 'queried' : 'querying',
      family: 'external',
      rest: (
        <>
          {' '}
          {label}
          {latch.mcp > 1 ? <> {bold(latch.mcp)}×</> : null}
        </>
      ),
    })
  }
  if (bashRan > 0) {
    fragments.push(counted(past ? 'ran' : 'running', bashRan, 'bash command', 'shell'))
  }
  if (bashBlocked > 0) {
    fragments.push(counted('blocked', bashBlocked, 'bash command', 'shell'))
  }
  const hadNonMemory = fragments.length > 0
  if (memoryReads > 0) {
    fragments.push(counted(past ? 'recalled' : 'recalling', memoryReads, 'memory', 'memory'))
  }
  if (memorySearches > 0) {
    fragments.push({
      verb: past ? 'searched memory' : 'searching memory',
      family: 'memory',
      rest: null,
    })
  }
  if (memoryWrites > 0) {
    fragments.push(
      counted(past ? 'noted' : 'noting', memoryWrites, 'memory update', 'memory'),
    )
  }
  void hadNonMemory

  const totalOps =
    latch.search +
    latch.read +
    latch.list +
    latch.mcp +
    bashRan +
    bashBlocked +
    memoryReads +
    memorySearches +
    memoryWrites

  if (verbose) return verboseGroupView({ message, tools, lookups, verbose, shellId, selectedBg, memberResultText })

  if (totalOps === 0 && gitOps === 0) return null


  let tail: React.ReactNode = null
  if (active) {
    let slowest: { elapsed: number; lines: number } | null = null
    const latestFrames = memberIds
      .filter(id => inProgressToolUseIDs.has(id))
      .map(id =>
        getEphemeralProgressFrame(id) ??
        lookups.progressMessagesByToolUseID.get(id)?.at(-1),
      )
    if (fullscreen) {
      for (const frame of latestFrames) {
        const data = frame?.data as
          | { type?: string; elapsedTimeSeconds?: number; totalLines?: number }
          | undefined
        if (
          (data?.type === 'bash_progress' || data?.type === 'powershell_progress') &&
          typeof data.elapsedTimeSeconds === 'number' &&
          data.elapsedTimeSeconds > 2
        ) {
          if (!slowest || data.elapsedTimeSeconds > slowest.elapsed) {
            slowest = {
              elapsed: data.elapsedTimeSeconds,
              lines: data.totalLines ?? 0,
            }
          }
        }
      }
    }
    const hookWait = hookWaitLineOf(latestFrames)
    tail = (
      <Text dimColor>
        {' '}
        {totalOps} {plural(totalOps, 'operation')}
        {slowest
          ? ` · ${Math.floor(slowest.elapsed)}s${slowest.lines > 0 ? ` · ${slowest.lines} ${plural(slowest.lines, 'line')}` : ''}`
          : ''}
        {hookWait !== null ? ` · ${hookWait}` : ''}
      </Text>
    )
  }

  const sentence: React.ReactNode[] = []
  fragments.forEach((fragment, index) => {
    if (index > 0) sentence.push(<Text key={`comma-${index}`}>, </Text>)
    const verb =
      index === 0
        ? fragment.verb.charAt(0).toUpperCase() + fragment.verb.slice(1)
        : fragment.verb
    sentence.push(
      <React.Fragment key={`frag-${index}`}>
        {verb}
        {fragment.rest}
      </React.Fragment>,
    )
  })

  return collapsedGroupView({ selectedBg, fragments, active, anyErrored, anyDenied, sentence, tail, hint, memberEntries, lookups, shellId, movedByOperator, memberResultText })
}

export default CollapsedReadSearchContent
