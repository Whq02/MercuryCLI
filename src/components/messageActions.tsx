// Transcript cursor mode: the navigability rules, the action table, copy
// extraction, the stable handler surface, and the action bar. The hook
// itself cannot register keybindings (it runs outside the keybinding
// provider); MessageActionsKeybindings is the tiny in-provider component
// that registers the returned map and renders nothing.

import React, { createContext, useContext, useMemo, useRef } from 'react'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useRegisterKeybindingContext } from '../keybindings/KeybindingContext.js'
import type {
  NormalizedUserMessage,
  RenderableMessage,
} from '../types/message.js'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  NO_RESPONSE_REQUESTED,
} from '../utils/messages.js'

// ── navigability ────────────────────────────────────────────────────────────

/** The navigable type tags (contract data). `turn_receipt` is present for
 *  type coverage only; the predicate excludes it. */
export type NavigableType =
  | 'user'
  | 'assistant'
  | 'grouped_tool_use'
  | 'collapsed_read_search'
  | 'system'
  | 'attachment'
  | 'turn_receipt'

export type NavigableMessage = RenderableMessage
export type NavigableOf<T extends NavigableType> = Extract<
  RenderableMessage,
  { type: T }
>

const ALL_NAVIGABLE_TYPES: readonly NavigableType[] = [
  'user',
  'assistant',
  'grouped_tool_use',
  'collapsed_read_search',
  'system',
  'attachment',
  'turn_receipt',
]

/** System subtypes excluded from navigation (contract data). */
const EXCLUDED_SYSTEM_SUBTYPES = new Set([
  'api_metrics',
  'stop_hook_summary',
  'turn_duration',
  'memory_saved',
  'agents_killed',
  'away_summary',
  'thinking',
])

/** Attachment types included in navigation (contract data). */
const INCLUDED_ATTACHMENT_TYPES = new Set([
  'queued_command',
  'diagnostics',
  'hook_blocking_error',
  'hook_error_during_execution',
])

/** Known synthetic message texts (interrupts and similar). */
const SYNTHETIC_TEXTS = new Set([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  NO_RESPONSE_REQUESTED,
])

/** The primary-input table (contract data): tool name → copy label and the
 *  input field the value is read from. Non-string values yield nothing;
 *  Tmux renders its args array as a command string. */
const PRIMARY_INPUT_TABLE: Record<string, { label: string; field: string }> = {
  Read: { label: 'path', field: 'file_path' },
  Edit: { label: 'path', field: 'file_path' },
  Write: { label: 'path', field: 'file_path' },
  NotebookEdit: { label: 'path', field: 'notebook_path' },
  Bash: { label: 'command', field: 'command' },
  Grep: { label: 'pattern', field: 'pattern' },
  Glob: { label: 'pattern', field: 'pattern' },
  WebFetch: { label: 'url', field: 'url' },
  WebSearch: { label: 'query', field: 'query' },
  ProviderSearch: { label: 'query', field: 'query' },
  Task: { label: 'prompt', field: 'prompt' },
  Agent: { label: 'prompt', field: 'prompt' },
  Tmux: { label: 'command', field: 'args' },
}

function primaryInputValue(name: string, input: unknown): string | undefined {
  const entry = PRIMARY_INPUT_TABLE[name]
  if (!entry || input === null || typeof input !== 'object') return undefined
  const raw = (input as Record<string, unknown>)[entry.field]
  if (name === 'Tmux') {
    if (!Array.isArray(raw)) return undefined
    return `tmux ${raw.join(' ')}`
  }
  return typeof raw === 'string' ? raw : undefined
}

/** Strip leading `<system-reminder>` … `</system-reminder>` blocks
 *  (contract-data tag spelling), trimming leading whitespace after each
 *  removal; an opening tag with no matching close stops the strip. */
export function stripSystemReminders(text: string): string {
  const OPEN = '<system-reminder>'
  const CLOSE = '</system-reminder>'
  let out = text.replace(/^\s+/, '')
  while (out.startsWith(OPEN)) {
    const closeAt = out.indexOf(CLOSE)
    if (closeAt === -1) break
    out = out.slice(closeAt + CLOSE.length).replace(/^\s+/, '')
  }
  return out
}

/** The tool call behind a message: an assistant message's first block when
 *  it is a tool call, or a grouped row's tool name with its first grouped
 *  message's input. */
export function toolCallOf(
  msg: NavigableMessage,
): { name: string; input: unknown } | undefined {
  if (msg.type === 'assistant') {
    const first = msg.message.content[0]
    if (first && first.type === 'tool_use') {
      return { name: first.name, input: first.input }
    }
    return undefined
  }
  if (msg.type === 'grouped_tool_use') {
    const first = msg.messages[0]?.message.content[0]
    if (first && first.type === 'tool_use') {
      return { name: msg.toolName, input: first.input }
    }
    return undefined
  }
  return undefined
}

/** The tier-2 navigability blocklist (on top of "measured height is
 *  non-zero", which the virtual list owns). */
export function isNavigableMessage(msg: NavigableMessage): boolean {
  switch (msg.type) {
    case 'assistant': {
      const first = msg.message.content[0]
      if (!first) return false
      if (first.type === 'text') {
        return first.text !== '' && !SYNTHETIC_TEXTS.has(first.text)
      }
      if (first.type === 'tool_use') return first.name in PRIMARY_INPUT_TABLE
      return false
    }
    case 'user': {
      if (msg.isMeta || msg.isCompactSummary) return false
      const first = msg.message.content[0]
      if (!first || first.type !== 'text') return false
      if (SYNTHETIC_TEXTS.has(first.text)) return false
      return !stripSystemReminders(first.text).startsWith('<')
    }
    case 'system':
      return !EXCLUDED_SYSTEM_SUBTYPES.has(msg.subtype)
    case 'grouped_tool_use':
    case 'collapsed_read_search':
      return true
    case 'turn_receipt':
      // A summary row with nothing behind it to open, copy or act on.
      return false
    case 'attachment':
      return INCLUDED_ATTACHMENT_TYPES.has(msg.attachment.type)
    default:
      return false
  }
}

// ── copy extraction ─────────────────────────────────────────────────────────

/** String content passes through; array content contributes its text blocks
 *  joined by newlines; anything else is empty. */
function toolResultText(result: NormalizedUserMessage): string {
  const first = result.message.content[0]
  if (!first || first.type !== 'tool_result') return ''
  const content = first.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => (block as { text: string }).text)
      .join('\n')
  }
  return ''
}

function joinedResultTexts(results: NormalizedUserMessage[]): string[] {
  return results.map(toolResultText).filter(text => text !== '')
}

export function copyTextOf(msg: NavigableMessage): string {
  switch (msg.type) {
    case 'user': {
      const first = msg.message.content[0]
      if (!first || first.type !== 'text') return ''
      return stripSystemReminders(first.text)
    }
    case 'assistant': {
      const first = msg.message.content[0]
      if (first && first.type === 'text') return first.text
      const call = toolCallOf(msg)
      if (call) return primaryInputValue(call.name, call.input) ?? ''
      return ''
    }
    case 'grouped_tool_use':
      return joinedResultTexts(msg.results).join('\n\n')
    case 'collapsed_read_search': {
      const parts: string[] = []
      for (const member of msg.messages) {
        if (member.type === 'user') {
          const text = toolResultText(member)
          if (text !== '') parts.push(text)
        } else if (member.type === 'grouped_tool_use') {
          parts.push(...joinedResultTexts(member.results))
        }
      }
      return parts.join('\n\n')
    }
    case 'system': {
      if ('content' in msg && typeof msg.content === 'string' && msg.content) {
        return msg.content
      }
      if ('error' in msg && msg.error !== undefined) return String(msg.error)
      return msg.subtype
    }
    case 'turn_receipt':
      return ''
    case 'attachment': {
      const attachment = msg.attachment
      if (attachment.type === 'queued_command') {
        if (typeof attachment.prompt === 'string') return attachment.prompt
        return attachment.prompt
          .filter(block => block.type === 'text')
          .map(block => (block as { text: string }).text)
          .join('\n')
      }
      return `[${attachment.type}]`
    }
    default:
      return ''
  }
}

// ── cursor state and the action table ───────────────────────────────────────

export type MessageActionsState = {
  uuid: string
  type: NavigableType
  expanded: boolean
  toolName?: string
}

/** The imperative navigation handle the virtual list implements (height
 *  measurement lives there). */
export type MessageActionsNav = {
  enter: () => void
  prev: () => void
  next: () => void
  prevUser: () => void
  nextUser: () => void
  top: () => void
  bottom: () => void
  getSelected: () => NavigableMessage | undefined
}

export type MessageActionCaps = {
  copy: (text: string) => void
  edit: (userMessage: NormalizedUserMessage) => Promise<void>
}

type MessageAction = {
  key: string
  label: (cursor: MessageActionsState) => string
  types: readonly NavigableType[]
  isApplicable?: (cursor: MessageActionsState) => boolean
  staysInCursorMode: boolean
  run: (
    message: NavigableMessage,
    caps: MessageActionCaps,
  ) => void | Promise<void>
}

export const MESSAGE_ACTIONS: readonly MessageAction[] = [
  {
    key: 'enter',
    label: cursor => (cursor.expanded ? 'collapse' : 'expand'),
    types: ['grouped_tool_use', 'collapsed_read_search', 'attachment', 'system'],
    staysInCursorMode: true,
    // Dispatch handles the toggle; the runner is deliberately empty.
    run: () => {},
  },
  {
    key: 'enter',
    label: () => 'edit',
    types: ['user'],
    staysInCursorMode: false,
    run: (message, caps) => {
      if (message.type === 'user') return caps.edit(message)
    },
  },
  {
    key: 'c',
    label: () => 'copy',
    types: ALL_NAVIGABLE_TYPES,
    staysInCursorMode: false,
    run: (message, caps) => {
      caps.copy(copyTextOf(message))
    },
  },
  {
    key: 'p',
    label: cursor =>
      `copy ${cursor.toolName ? (PRIMARY_INPUT_TABLE[cursor.toolName]?.label ?? '') : ''}`,
    types: ['grouped_tool_use', 'assistant'],
    isApplicable: cursor =>
      cursor.toolName !== undefined && cursor.toolName in PRIMARY_INPUT_TABLE,
    staysInCursorMode: false,
    run: (message, caps) => {
      const call = toolCallOf(message)
      if (!call) return
      const value = primaryInputValue(call.name, call.input)
      if (value) caps.copy(value)
    },
  },
]

function applicableActions(cursor: MessageActionsState): MessageAction[] {
  return MESSAGE_ACTIONS.filter(
    action =>
      action.types.includes(cursor.type) &&
      (action.isApplicable === undefined || action.isApplicable(cursor)),
  )
}

// ── the hook ────────────────────────────────────────────────────────────────

export function useMessageActions(
  cursor: MessageActionsState | null,
  setCursor: (cursor: MessageActionsState | null) => void,
  navRef: React.RefObject<MessageActionsNav | null>,
  caps: MessageActionCaps,
): {
  enter: () => void
  handlers: Record<string, () => void>
} {
  // Handlers must be stable across renders so appending a message does not
  // re-register the entire binding set — cursor and capabilities ride refs.
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor
  const capsRef = useRef(caps)
  capsRef.current = caps
  const setCursorRef = useRef(setCursor)
  setCursorRef.current = setCursor

  return useMemo(() => {
    const exit = (): void => {
      setCursorRef.current(null)
    }
    const runKey = (key: string): void => {
      const current = cursorRef.current
      if (!current) return
      const action = applicableActions(current).find(a => a.key === key)
      if (!action) return
      if (action.staysInCursorMode) {
        setCursorRef.current({ ...current, expanded: !current.expanded })
        return
      }
      const selected = navRef.current?.getSelected()
      if (!selected) return
      void action.run(selected, capsRef.current)
      exit()
    }
    return {
      enter: (): void => {
        navRef.current?.enter()
      },
      handlers: {
        'messageActions:prev': (): void => {
          navRef.current?.prev()
        },
        'messageActions:next': (): void => {
          navRef.current?.next()
        },
        'messageActions:prevUser': (): void => {
          navRef.current?.prevUser()
        },
        'messageActions:nextUser': (): void => {
          navRef.current?.nextUser()
        },
        'messageActions:top': (): void => {
          navRef.current?.top()
        },
        'messageActions:bottom': (): void => {
          navRef.current?.bottom()
        },
        'messageActions:escape': (): void => {
          // Collapse first when expanded; only then exit cursor mode.
          const current = cursorRef.current
          if (current?.expanded) {
            setCursorRef.current({ ...current, expanded: false })
            return
          }
          exit()
        },
        'messageActions:ctrlc': (): void => {
          // Skips the collapse step: interrupting from an expanded row
          // during streaming must not cost three presses.
          exit()
        },
        'messageActions:enter': (): void => {
          runKey('enter')
        },
        'messageActions:c': (): void => {
          runKey('c')
        },
        'messageActions:p': (): void => {
          runKey('p')
        },
      },
    }
  }, [navRef])
}

/** Mounted inside the keybinding provider; registers the handler map under
 *  the MessageActions context and renders nothing. */
export function MessageActionsKeybindings({
  handlers,
  isActive,
}: {
  handlers: Record<string, () => void>
  isActive: boolean
}): React.ReactNode {
  useRegisterKeybindingContext('MessageActions', isActive)
  useKeybindings(handlers, { context: 'MessageActions', isActive })
  return null
}

// ── the action bar ──────────────────────────────────────────────────────────

export function MessageActionsBar({
  cursor,
}: {
  cursor: MessageActionsState
}): React.ReactNode {
  const actions = applicableActions(cursor)
  return (
    <Box flexDirection="column" flexShrink={0} paddingY={1}>
      <Box
        borderStyle="single"
        borderTop={true}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor="promptBorderResting"
      />
      <Box paddingX={2} paddingY={1}>
        <Text>
          {actions.map((action, index) => (
            <Text key={`${action.key}-${index}`}>
              {index > 0 ? <Text dimColor> · </Text> : null}
              <Text bold>{action.key}</Text>
              <Text dimColor> {action.label(cursor)}</Text>
            </Text>
          ))}
          <Text dimColor> · </Text>
          <Text bold>↑↓</Text>
          <Text dimColor> navigate</Text>
          <Text dimColor> · </Text>
          <Text bold>esc</Text>
          <Text dimColor> back</Text>
        </Text>
      </Box>
    </Box>
  )
}

// ── selected-message background ─────────────────────────────────────────────

/** True on the currently selected message's subtree. */
export const MessageActionsSelectedContext = createContext<boolean>(false)

/** Whether rendering is happening inside the virtual list. */
export const InVirtualListContext = createContext<boolean>(false)

/** The background role for the selected message; consumers must apply it to
 *  the box that owns the top margin so the margin is not painted. */
export function useSelectedMessageBg(): string | undefined {
  const selected = useContext(MessageActionsSelectedContext)
  return selected ? 'messageActionsBackground' : undefined
}
