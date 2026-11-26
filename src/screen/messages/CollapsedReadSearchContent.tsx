import React, { useRef } from 'react'
import { Text } from '../themedRenderer.js'
import type {
  CollapsedReadSearchGroup,
} from '../../engine/message-shapes/message.js'
import type { Tools } from '../../tools/kit/tool.js'
import { useMinDisplayTime } from '../effects/useMinDisplayTime.js'
import type { MessageLookups } from '../../engine/messages/lookups.js'
import { isFullscreenEnvEnabled } from '../fullscreen-layout/fullscreen.js'
import { plural } from '../../platform/text/strings.js'
import { toTildePath } from '../../platform/files/path.js'
import { useFluxMountMark } from './useFluxMountMark.js'
import {
  getEphemeralProgressFrame,
  useEphemeralProgressVersion,
} from '../app-state/ephemeralProgressStore.js'
import { hookWaitLineOf } from '../../integrations/event-hooks/wait.js'
import {
  firstRunningShellId,
  movedToBackgroundByOperator,
  type ToolUseEntryV1,
} from '../../engine/connector/shellRunning.js'
import { useSelectedMessageBg } from './messageActions.js'
import { BASH_TOOL_NAME } from '../../tools/kit/names/bash.js'
import { isUserInterruptResultText } from '../../engine/message-shapes/rejectionText.js'
import { collapsedGroupView, verboseGroupView, type Fragment } from './collapsed-read-search/views.js'

const HINT_MIN_DISPLAY_MS = 700

function bold(n: number): React.ReactNode {
  return <Text bold>{n}</Text>
}

function counted(verb: string, n: number, noun: string): Fragment {
  return {
    verb,
    rest: (
      <>
        {' '}
        {bold(n)} {plural(n, noun)}
      </>
    ),
  }
}

function commitVerb(kind: string, active: boolean): string {
  if (kind === 'amended') return active ? 'amending' : 'amended'
  if (kind === 'cherry-picked') return active ? 'cherry-picking' : 'cherry-picked'
  return active ? 'committing' : 'committed'
}

function branchVerb(action: string, active: boolean): string {
  if (action === 'rebased') return active ? 'rebasing' : 'rebased'
  return active ? 'merging' : 'merged'
}

function prActionVerb(action: string, active: boolean): string {
  if (action === 'created') return active ? 'opening' : 'opened'
  if (!active) return action
  return `${action.replace(/e?d$/, '')}ing`
}

function extractMemberEntries(message: CollapsedReadSearchGroup): ToolUseEntryV1[] {
  const entries: ToolUseEntryV1[] = []
  for (const member of message.messages) {
    if (member.type === 'grouped_tool_use') {
      for (const inner of member.messages) {
        const first = inner.message.content[0]
        if (first && first.type === 'tool_use') {
          entries.push({ id: first.id, name: first.name })
        }
      }
    } else if (member.type === 'assistant') {
      const first = member.message.content[0]
      if (first && first.type === 'tool_use') {
        entries.push({ id: first.id, name: first.name })
      }
    }
  }
  return entries
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

function buildFragments(args: {
  active: boolean
  commits: NonNullable<CollapsedReadSearchGroup['commits']>
  pushes: NonNullable<CollapsedReadSearchGroup['pushes']>
  branches: NonNullable<CollapsedReadSearchGroup['branches']>
  prs: NonNullable<CollapsedReadSearchGroup['prs']>
  searchCount: number
  readCount: number
  listCount: number
  mcpCallCount: number
  mcpServerNames: string[] | undefined
  bashRan: number
  bashBlocked: number
  bashInterrupted: number
  memoryReadCount: number
  memorySearchCount: number
  memoryWriteCount: number
}): Fragment[] {
  const {
    active,
    commits,
    pushes,
    branches,
    prs,
    searchCount,
    readCount,
    listCount,
    mcpCallCount,
    mcpServerNames,
    bashRan,
    bashBlocked,
    bashInterrupted,
    memoryReadCount,
    memorySearchCount,
    memoryWriteCount,
  } = args
  const fragments: Fragment[] = []

  for (const commit of commits) {
    fragments.push({
      verb: commitVerb(commit.kind, active),
      rest: (
        <>
          {' '}
          <Text bold>{commit.sha.slice(0, 7)}</Text>
        </>
      ),
    })
  }
  for (const push of pushes) {
    fragments.push({
      verb: active ? 'pushing' : 'pushed',
      rest: (
        <>
          {' '}
          <Text bold>{push.branch}</Text>
        </>
      ),
    })
  }
  for (const branch of branches) {
    fragments.push({
      verb: branchVerb(branch.action, active),
      rest: (
        <>
          {' '}
          <Text bold>{branch.ref}</Text>
        </>
      ),
    })
  }
  for (const pr of prs) {
    fragments.push({
      verb: prActionVerb(pr.action, active),
      rest: (
        <>
          {' PR '}
          <Text bold>{`#${pr.number}`}</Text>
        </>
      ),
    })
  }

  if (searchCount > 0) {
    fragments.push(counted(active ? 'searching for' : 'searched for', searchCount, 'pattern'))
  }
  if (readCount > 0) {
    fragments.push(counted(active ? 'reading' : 'read', readCount, 'file'))
  }
  if (listCount > 0) {
    fragments.push(counted(active ? 'listing' : 'listed', listCount, 'directory'))
  }
  if (mcpCallCount > 0) {
    const cleanedServers = [
      ...new Set(
        (mcpServerNames ?? [])
          .map(name => name.replace(/^claude\.ai /, '').trim())
          .filter(Boolean),
      ),
    ]
    const serverLabel = cleanedServers.length > 0 ? cleanedServers.join(', ') : 'MCP'
    fragments.push({
      verb: active ? 'querying' : 'queried',
      rest: (
        <>
          {' '}
          {serverLabel}
          {mcpCallCount > 1 ? (
            <>
              {' '}
              <Text bold>{`${mcpCallCount}×`}</Text>
            </>
          ) : null}
        </>
      ),
    })
  }

  if (bashRan > 0) {
    fragments.push(counted(active ? 'running' : 'ran', bashRan, 'bash command'))
  }
  if (bashBlocked > 0) {
    fragments.push(counted('blocked', bashBlocked, 'bash command'))
  }
  if (bashInterrupted > 0) {
    fragments.push(counted('interrupted', bashInterrupted, 'bash command'))
  }

  if (memoryReadCount > 0) {
    fragments.push(counted(active ? 'recalling' : 'recalled', memoryReadCount, 'memory'))
  }
  if (memorySearchCount > 0) {
    fragments.push({
      verb: active ? 'searching memory' : 'searched memory',
      rest: null,
    })
  }
  if (memoryWriteCount > 0) {
    fragments.push(
      counted(active ? 'noting' : 'noted', memoryWriteCount, 'memory update'),
    )
  }
  return fragments
}

export function CollapsedReadSearchContent({
  message,
  inProgressToolUseIDs,
  shouldAnimate: _shouldAnimate,
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
  useFluxMountMark('read-group')
  const selectedBg = useSelectedMessageBg()

  const memberEntries = extractMemberEntries(message)
  const memberIds = memberEntries.map(entry => entry.id)
  useEphemeralProgressVersion(memberIds)

  const fullscreen = isFullscreenEnvEnabled()
  const latchRef = useRef({
    read: 0,
    search: 0,
    list: 0,
    mcp: 0,
    bash: 0,
  })
  latchRef.current.read = Math.max(latchRef.current.read, message.readCount)
  latchRef.current.search = Math.max(latchRef.current.search, message.searchCount)
  latchRef.current.list = Math.max(latchRef.current.list, message.listCount)
  latchRef.current.mcp = Math.max(latchRef.current.mcp, message.mcpCallCount ?? 0)
  if (fullscreen) {
    latchRef.current.bash = Math.max(latchRef.current.bash, message.bashCount ?? 0)
  }

  const readCount = latchRef.current.read
  const searchCount = latchRef.current.search
  const listCount = latchRef.current.list
  const mcpCallCount = latchRef.current.mcp
  const bashCount = fullscreen ? latchRef.current.bash : 0
  const gitOpBashCount = fullscreen ? (message.gitOpBashCount ?? 0) : 0

  const anyInProgress = memberEntries.some(entry => inProgressToolUseIDs.has(entry.id))
  const anyUnsettled = memberEntries.some(
    entry =>
      !lookups.resolvedToolUseIDs.has(entry.id) &&
      !lookups.erroredToolUseIDs.has(entry.id) &&
      !lookups.deniedToolUseIDs.has(entry.id),
  )
  const active = anyInProgress || anyUnsettled

  const rawHint =
    isActiveGroup && anyInProgress
      ? (message.latestDisplayHint ??
        (message.readFilePaths.length > 0
          ? toTildePath(message.readFilePaths[message.readFilePaths.length - 1]!)
          : message.searchArgs.length > 0
            ? `"${message.searchArgs[message.searchArgs.length - 1]!}"`
            : null))
      : null
  const hint = useMinDisplayTime(rawHint, HINT_MIN_DISPLAY_MS)

  const shellId = isTranscriptMode ? null : firstRunningShellId(memberEntries, inProgressToolUseIDs)

  if (verbose) {
    return verboseGroupView({
      message,
      tools,
      lookups,
      verbose,
      shellId,
      selectedBg,
      memberResultText,
    })
  }

  const commits = fullscreen ? (message.commits ?? []) : []
  const pushes = fullscreen ? (message.pushes ?? []) : []
  const branches = fullscreen ? (message.branches ?? []) : []
  const prs = fullscreen ? (message.prs ?? []) : []
  const gitOps = commits.length + pushes.length + branches.length + prs.length
  const totalOps =
    readCount +
    searchCount +
    listCount +
    mcpCallCount +
    bashCount +
    message.memoryReadCount +
    message.memorySearchCount +
    message.memoryWriteCount

  if (totalOps === 0 && gitOps === 0) {
    return null
  }

  let bashDenied = 0
  let bashInterrupted = 0
  let bashBlocked = 0
  if (fullscreen) {
    for (const entry of memberEntries) {
      if (entry.name !== BASH_TOOL_NAME) continue
      if (!lookups.deniedToolUseIDs.has(entry.id)) continue
      bashDenied += 1
      if (isUserInterruptResultText(memberResultText(lookups, entry.id))) {
        bashInterrupted += 1
      } else {
        bashBlocked += 1
      }
    }
  }
  const bashRan = Math.max(0, bashCount - gitOpBashCount - bashDenied)

  const fragments = buildFragments({
    active,
    commits,
    pushes,
    branches,
    prs,
    searchCount,
    readCount,
    listCount,
    mcpCallCount,
    mcpServerNames: message.mcpServerNames,
    bashRan,
    bashBlocked,
    bashInterrupted,
    memoryReadCount: message.memoryReadCount,
    memorySearchCount: message.memorySearchCount,
    memoryWriteCount: message.memoryWriteCount,
  })

  const sentence: React.ReactNode[] = fragments.map((fragment, index) => {
    const verb =
      index === 0
        ? fragment.verb.slice(0, 1).toUpperCase() + fragment.verb.slice(1)
        : fragment.verb
    return (
      <React.Fragment key={index}>
        {index > 0 ? ', ' : ''}
        {verb}
        {fragment.rest}
      </React.Fragment>
    )
  })

  const progressFrames = memberEntries.map(entry => getEphemeralProgressFrame(entry.id))
  const hookWait = hookWaitLineOf(progressFrames)

  let slowestShell: { elapsedTimeSeconds: number; totalLines: number } | null = null
  if (active && fullscreen) {
    for (let i = 0; i < memberEntries.length; i++) {
      const entry = memberEntries[i]!
      if (!inProgressToolUseIDs.has(entry.id)) continue
      const data = progressFrames[i]?.data
      if (data?.type !== 'bash_progress' && data?.type !== 'powershell_progress') continue
      if (data.elapsedTimeSeconds > 2) {
        if (
          slowestShell === null ||
          data.elapsedTimeSeconds > slowestShell.elapsedTimeSeconds
        ) {
          slowestShell = {
            elapsedTimeSeconds: data.elapsedTimeSeconds,
            totalLines: data.totalLines,
          }
        }
      }
    }
  }

  let tail: React.ReactNode = null
  if (active) {
    const parts: string[] = [`${totalOps} ${plural(totalOps, 'operation')}`]
    if (slowestShell !== null) {
      parts.push(`${Math.round(slowestShell.elapsedTimeSeconds)}s`)
      if (slowestShell.totalLines > 0) {
        parts.push(`${slowestShell.totalLines} ${plural(slowestShell.totalLines, 'line')}`)
      }
    }
    if (hookWait !== null) {
      parts.push(hookWait)
    }
    tail = <Text dimColor>{` · ${parts.join(' · ')}`}</Text>
  }

  const anyErrored = memberEntries.some(entry => lookups.erroredToolUseIDs.has(entry.id))
  const anyDenied = memberEntries.some(entry => lookups.deniedToolUseIDs.has(entry.id))
  const movedByOperator = memberEntries.some(entry => {
    const holder = lookups.toolResultByToolUseID.get(entry.id)
    const result = holder?.type === 'user' ? holder.toolUseResult : undefined
    return movedToBackgroundByOperator(result)
  })

  return collapsedGroupView({
    selectedBg,
    active,
    anyErrored,
    anyDenied,
    sentence,
    tail,
    hint,
    memberEntries,
    lookups,
    shellId,
    movedByOperator,
    memberResultText,
  })
}

export default CollapsedReadSearchContent
