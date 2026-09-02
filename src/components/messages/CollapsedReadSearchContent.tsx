// The folded read/search/list/repl/mcp/bash/memory group summary. The
// fullscreen-experience gate governs the SHELL half of this row — git
// outcomes, the bash count and the elapsed tail exist only under it, so a
// plain-terminal transcript never claims shell activity it did not surface.
// Counts only ever increase (latched at their maximum seen value): the
// group re-renders on a debounce and can observe a transient dip inside the
// streaming executor that would otherwise paint as flicker.

import React, { useRef, useState } from 'react'
import { Ansi, Box, Text } from '../../ink.js'
import type {
  CollapsedReadSearchGroup,
  ProgressMessage,
} from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import { findToolByName, safeUserFacingName } from '../../Tool.js'
import { useMinDisplayTime } from '../../hooks/useMinDisplayTime.js'
import { REPL_ONLY_TOOLS } from '../../tools/REPLTool/constants.js'
import { getReplPrimitiveTools } from '../../tools/REPLTool/primitiveTools.js'
import type { MessageLookups } from '../../utils/messages/lookups.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { logError } from '../../utils/log.js'
import { formatDuration } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import { toTildePath } from '../../utils/path.js'
import { useFluxMountMark } from '../../hooks/useFluxMountMark.js'
import {
  getEphemeralProgressFrame,
  useEphemeralProgressVersion,
} from '../../state/ephemeralProgressStore.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { MessageResponse } from '../MessageResponse.js'
import { ToolUseLoader } from '../ToolUseLoader.js'
import { TranscriptNameplate } from './TranscriptNameplate.js'
import { useSelectedMessageBg } from '../messageActions.js'

const HINT_MIN_DISPLAY_MS = 700

/** One sentence fragment: the leading verb (capitalisable) plus the styled
 *  remainder node. */
type Fragment = { verb: string; rest: React.ReactNode }

function bold(n: number): React.ReactNode {
  return <Text bold>{n}</Text>
}

/** Compose one verb fragment with a bolded count. */
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

function memberToolUseIds(group: CollapsedReadSearchGroup): string[] {
  const ids: string[] = []
  for (const member of group.messages) {
    if (member.type === 'grouped_tool_use') {
      for (const inner of member.messages) {
        const first = inner.message.content[0]
        if (first && first.type === 'tool_use') ids.push(first.id)
      }
      continue
    }
    const first = member.message.content[0]
    if (first && first.type === 'tool_use') ids.push(first.id)
  }
  return ids
}

export function CollapsedReadSearchContent({
  message,
  inProgressToolUseIDs,
  shouldAnimate = false,
  verbose = false,
  tools,
  lookups,
  isActiveGroup = false,
}: {
  message: CollapsedReadSearchGroup
  inProgressToolUseIDs: Set<string>
  shouldAnimate?: boolean
  verbose?: boolean
  tools: Tools
  lookups: MessageLookups
  isActiveGroup?: boolean
}): React.ReactNode {
  const fullscreen = isFullscreenEnvEnabled()
  // The selected-message background belongs on the outermost box of the
  // card so the whole row paints under the message-actions cursor.
  const selectedBg = useSelectedMessageBg()
  const memberIds = React.useMemo(() => memberToolUseIds(message), [message])
  // Own members only — an unrelated tool's tick must not repaint this card.
  useEphemeralProgressVersion(memberIds)
  // The GROUP kind — the provers count one read-group mount per collapsed
  // card, not per member uuid.
  useFluxMountMark('read-group')

  // ── latched counts (only ever increase) ───────────────────────────────
  const latchRef = useRef({ read: 0, search: 0, list: 0, mcp: 0, bash: 0 })
  const latch = latchRef.current
  latch.read = Math.max(latch.read, message.readCount)
  latch.search = Math.max(latch.search, message.searchCount)
  latch.list = Math.max(latch.list, message.listCount)
  latch.mcp = Math.max(latch.mcp, message.mcpCallCount ?? 0)
  latch.bash = Math.max(latch.bash, fullscreen ? (message.bashCount ?? 0) : 0)
  // Live reads (no dip): repl, memory counts, git-op count.
  const replCount = message.replCount
  const memoryReads = message.memoryReadCount
  const memorySearches = message.memorySearchCount
  const memoryWrites = message.memoryWriteCount
  const gitOps = fullscreen ? (message.gitOpBashCount ?? 0) : 0
  const bashCount = Math.max(0, latch.bash - gitOps)

  // ── glyph state ───────────────────────────────────────────────────────
  const anyErrored = memberIds.some(id => lookups.erroredToolUseIDs.has(id))
  const anyDenied = memberIds.some(id => lookups.deniedToolUseIDs.has(id))
  const active = isActiveGroup && memberIds.some(id => inProgressToolUseIDs.has(id))

  // ── the hint row (active groups) — floored via the shared
  // minimum-display-time hook so a fast-cycling target stays readable ─────
  let rawHint: string | null = null
  if (active) {
    // Priority 1: a live REPL call's inner target from the newest frame.
    for (let i = memberIds.length - 1; i >= 0 && rawHint === null; i--) {
      const id = memberIds[i]!
      const frame =
        getEphemeralProgressFrame(id) ??
        lookups.progressMessagesByToolUseID.get(id)?.at(-1)
      const data = frame?.data as
        | {
            type?: string
            phase?: string
            filePath?: string
            pattern?: string
            command?: string
            toolName?: string
          }
        | undefined
      if (data?.type === 'repl_tool_call' && data.phase === 'start') {
        rawHint =
          data.filePath ??
          (data.pattern ? `"${data.pattern}"` : undefined) ??
          data.command ??
          data.toolName ??
          null
      }
    }
    if (rawHint === null && message.latestDisplayHint) rawHint = message.latestDisplayHint
    if (rawHint === null && message.readFilePaths.length > 0) {
      rawHint = toTildePath(message.readFilePaths[message.readFilePaths.length - 1]!)
    }
    if (rawHint === null && message.searchArgs.length > 0) {
      rawHint = `"${message.searchArgs[message.searchArgs.length - 1]!}"`
    }
  }
  const hint = useMinDisplayTime(rawHint, HINT_MIN_DISPLAY_MS)
  const pureRead =
    latch.read > 0 &&
    latch.search === 0 &&
    latch.list === 0 &&
    replCount === 0 &&
    latch.mcp === 0 &&
    bashCount === 0 &&
    gitOps === 0 &&
    memoryReads === 0 &&
    memoryWrites === 0

  // ── sentence composition ──────────────────────────────────────────────
  const past = !active
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
    fragments.push(counted(past ? 'searched for' : 'searching for', latch.search, 'pattern'))
  }
  if (latch.read > 0) {
    fragments.push(counted(past ? 'read' : 'reading', latch.read, 'file'))
  }
  if (latch.list > 0) {
    fragments.push(counted(past ? 'listed' : 'listing', latch.list, 'directory'))
  }
  if (replCount > 0) {
    fragments.push(counted(past ? 'evaluated' : 'evaluating', replCount, 'REPL call'))
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
      rest: (
        <>
          {' '}
          {label}
          {latch.mcp > 1 ? <> {bold(latch.mcp)}×</> : null}
        </>
      ),
    })
  }
  if (bashCount > 0) {
    fragments.push(counted(past ? 'ran' : 'running', bashCount, 'bash command'))
  }
  const hadNonMemory = fragments.length > 0
  if (memoryReads > 0) {
    fragments.push(counted(past ? 'recalled' : 'recalling', memoryReads, 'memory'))
  }
  if (memorySearches > 0) {
    fragments.push({
      verb: past ? 'searched memory' : 'searching memory',
      rest: null,
    })
  }
  if (memoryWrites > 0) {
    fragments.push(
      counted(past ? 'noted' : 'noting', memoryWrites, 'memory update'),
    )
  }
  void hadNonMemory

  const totalOps =
    latch.search +
    latch.read +
    latch.list +
    replCount +
    latch.mcp +
    bashCount +
    memoryReads +
    memoryWrites

  // ── verbose: one block per member ─────────────────────────────────────
  if (verbose) {
    const blocks: React.ReactNode[] = []
    const flat: Array<{ id: string; name: string; input: unknown }> = []
    for (const member of message.messages) {
      if (member.type === 'grouped_tool_use') {
        for (const inner of member.messages) {
          const first = inner.message.content[0]
          if (first && first.type === 'tool_use') {
            flat.push({ id: first.id, name: first.name, input: first.input })
          }
        }
      } else {
        const first = member.message.content[0]
        if (first && first.type === 'tool_use') {
          flat.push({ id: first.id, name: first.name, input: first.input })
        }
      }
    }
    for (const entry of flat) {
      let tool = findToolByName(tools, entry.name)
      if (!tool && REPL_ONLY_TOOLS.has(entry.name)) {
        // Retry against the REPL primitive registry before dropping.
        tool = findToolByName(getReplPrimitiveTools(), entry.name)
      }
      if (!tool) continue
      let target: React.ReactNode | string | null = null
      try {
        // The member header is the compact tool-row grammar (display path,
        // like the standalone rows beside it in transcript mode); only the
        // result body below is the verbose rendering. The row's cut is
        // middle-anchored so even a deep display path keeps its filename.
        target = tool.renderToolUseMessage?.(entry.input, { verbose: false }) ?? null
      } catch (error) {
        logError(error)
        target = null
      }
      const resolvedMember = lookups.resolvedToolUseIDs.has(entry.id)
      const erroredMember = lookups.erroredToolUseIDs.has(entry.id)
      let resultNode: React.ReactNode = null
      if (resolvedMember && !erroredMember) {
        const raw = (
          lookups.toolResultByToolUseID.get(entry.id) as
            | { toolUseResult?: unknown }
            | undefined
        )?.toolUseResult
        if (raw !== undefined) {
          const validated = tool.outputSchema
            ? tool.outputSchema.safeParse(raw)
            : { success: true as const, data: raw }
          if (validated.success) {
            try {
              resultNode =
                tool.renderToolResultMessage?.(validated.data, [], {
                  verbose,
                  tools,
                }) ?? null
            } catch (error) {
              logError(error)
              resultNode = null
            }
          }
        }
      }
      blocks.push(
        <Box key={entry.id} flexDirection="column">
          <Box>
            {/* Box-returning leaf: a row sibling, never inside the Text. */}
            <ToolUseLoader
              isError={erroredMember}
              isUnresolved={!resolvedMember}
              shouldAnimate={false}
              isDenied={lookups.deniedToolUseIDs.has(entry.id)}
            />
            <Text wrap="truncate-middle">
              {' '}
              <Text bold>{safeUserFacingName(tool, entry.input, entry.name)}</Text>
              {target ? <Text dimColor> {target}</Text> : null}
            </Text>
          </Box>
          {resultNode ? <Box paddingLeft={2}>{resultNode}</Box> : null}
        </Box>,
      )
    }
    return (
      <Box flexDirection="column" backgroundColor={selectedBg}>
        <Text>
          <TranscriptNameplate />
          <Text dimColor>Expanded group ({flat.length} {plural(flat.length, 'call')})</Text>
        </Text>
        {blocks}
        {(message.hookCount ?? 0) > 0 ? (
          <MessageResponse height={1}>
            <Text dimColor>
              Ran {message.hookCount} PreToolUse {plural(message.hookCount ?? 0, 'hook')}
              {message.hookTotalMs ? ` in ${formatDuration(message.hookTotalMs)}` : ''}
            </Text>
          </MessageResponse>
        ) : null}
        {(message.relevantMemories ?? []).map(memory => (
          <Box key={memory.path} flexDirection="column" paddingLeft={2}>
            <Text dimColor>{toTildePath(memory.path)}</Text>
            <Ansi dimColor>{memory.content}</Ansi>
          </Box>
        ))}
      </Box>
    )
  }

  // The zero check runs after the verbose branch: a group whose only
  // activity was git operations still renders (git ops keep it non-empty).
  if (totalOps === 0 && gitOps === 0) return null


  // ── the active tail (real numbers only) ───────────────────────────────
  let tail: React.ReactNode = null
  if (active) {
    let slowest: { elapsed: number; lines: number } | null = null
    if (fullscreen) {
      for (const id of memberIds) {
        if (!inProgressToolUseIDs.has(id)) continue
        const frame =
          getEphemeralProgressFrame(id) ??
          lookups.progressMessagesByToolUseID.get(id)?.at(-1)
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
    tail = (
      <Text dimColor>
        {' '}
        {totalOps} {plural(totalOps, 'operation')}
        {slowest
          ? ` · ${Math.floor(slowest.elapsed)}s${slowest.lines > 0 ? ` · ${slowest.lines} ${plural(slowest.lines, 'line')}` : ''}`
          : ''}
      </Text>
    )
  }

  // Only the first fragment of the whole sentence is capitalised.
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

  return (
    <Box flexDirection="column" backgroundColor={selectedBg}>
      <Box>
        {/* Non-shrinking: beside the truncating sentence a bare Text row
            child is shrunk and wraps the name onto a second line. */}
        <Box flexShrink={0}>
          <TranscriptNameplate />
        </Box>
        {/* Box-returning leaf: a row sibling, never inside the Text. */}
        <ToolUseLoader
          isError={anyErrored || anyDenied}
          isUnresolved={active}
          shouldAnimate={shouldAnimate && active}
          isRead={pureRead && !active && !anyErrored}
          isDenied={anyDenied}
        />
        <Text wrap="truncate-end">
          {' '}
          <Text color={active ? undefined : 'subtle'}>
            {sentence}
            {active ? '…' : ''}
          </Text>{' '}
          <CtrlOToExpand />
          {tail}
        </Text>
      </Box>
      {active && hint !== null ? (
        <MessageResponse>
          <Text dimColor wrap="wrap">
            {hint}
          </Text>
        </MessageResponse>
      ) : null}
      {!verbose && (message.hookCount ?? 0) > 0 ? (
        <MessageResponse height={1}>
          <Text dimColor>
            Ran {message.hookCount} PreToolUse{' '}
            {plural(message.hookCount ?? 0, 'hook')}
            {message.hookTotalMs ? ` in ${formatDuration(message.hookTotalMs)}` : ''}
          </Text>
        </MessageResponse>
      ) : null}
    </Box>
  )
}

export default CollapsedReadSearchContent
