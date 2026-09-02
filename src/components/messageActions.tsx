
import React, { createContext, useContext, useMemo, useRef } from 'react'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useRegisterKeybindingContext } from '../keybindings/KeybindingContext.js'
import { getMessageCursor, setMessageCursor, useMessageCursor } from './messageCursorStore.js'
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

const EXCLUDED_SYSTEM_SUBTYPES = new Set([
  'api_metrics',
  'stop_hook_summary',
  'turn_duration',
  'memory_saved',
  'agents_killed',
  'away_summary',
  'thinking',
])

const INCLUDED_ATTACHMENT_TYPES = new Set([
  'queued_command',
  'diagnostics',
  'hook_blocking_error',
  'hook_error_during_execution',
])

const SYNTHETIC_TEXTS = new Set([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  NO_RESPONSE_REQUESTED,
])

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
      return false
    case 'attachment':
      return INCLUDED_ATTACHMENT_TYPES.has(msg.attachment.type)
    default:
      return false
  }
}


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


export type MessageActionsState = {
  uuid: string
  type: NavigableType
  expanded: boolean
  toolName?: string
}

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


export function useMessageActions(
  navRef: React.RefObject<MessageActionsNav | null>,
  caps: MessageActionCaps,
): {
  enter: () => void
  handlers: Record<string, () => void>
} {
  const capsRef = useRef(caps)
  capsRef.current = caps

  return useMemo(() => {
    const exit = (): void => {
      setMessageCursor(null)
    }
    const runKey = (key: string): void => {
      const current = getMessageCursor()
      if (!current) return
      const action = applicableActions(current).find(a => a.key === key)
      if (!action) return
      if (action.staysInCursorMode) {
        setMessageCursor({ ...current, expanded: !current.expanded })
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
          const current = getMessageCursor()
          if (current?.expanded) {
            setMessageCursor({ ...current, expanded: false })
            return
          }
          exit()
        },
        'messageActions:ctrlc': (): void => {
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


export function MessageActionsBar({
  cursor: given,
}: {
  cursor?: MessageActionsState
} = {}): React.ReactNode {
  const live = useMessageCursor()
  const cursor = given ?? live
  if (!cursor) return null
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


export const MessageActionsSelectedContext = createContext<boolean>(false)

export const InVirtualListContext = createContext<boolean>(false)

export function useSelectedMessageBg(): string | undefined {
  const selected = useContext(MessageActionsSelectedContext)
  return selected ? 'messageActionsBackground' : undefined
}
