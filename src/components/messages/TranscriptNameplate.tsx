import os from 'node:os'
import * as React from 'react'
import { Text } from '../../ink.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { ADVISOR_PLATE_NAME, SATURN_PLATE_NAME } from '../../utils/messages/noticeRows.js'
import { FAINT, TEAL } from '../mercuryPalette.js'
import { truncateToWidth } from '../mercury-ui/glyphs.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'


export type MessageRole = 'user' | 'assistant'

export type AttachedAuthor = 'user' | 'coordinator' | 'agent' | 'saturn' | 'advisor'

export function attachedPlateName(author: AttachedAuthor): string {
  return author === 'agent' ? 'Mercury' : author === 'coordinator' ? 'Coordinator' : author === 'saturn' ? SATURN_PLATE_NAME : author === 'advisor' ? ADVISOR_PLATE_NAME : userHandle()
}

export const AttachedAttributionContext = React.createContext<
  ((message: { type?: string }) => 'user' | 'coordinator') | null
>(null)

export const NameplateAccentContext = React.createContext<string | null>(null)

export const CrewmatePlateContext = React.createContext<{ agent: string; user: string } | null>(null)

type MessageMeta = {
  timestamp?: string
  role: MessageRole
  attachedAuthor?: AttachedAuthor
  queued?: boolean
  heldFor?: 'compaction'
}

const MessageMetaContext = React.createContext<MessageMeta | null>(null)

export function useMessageMeta(): MessageMeta | null {
  return React.useContext(MessageMetaContext)
}

export const NameplateContinuationContext = React.createContext<boolean>(false)

export function MessageMetaProvider({
  message,
  children,
}: {
  message: { type?: string; timestamp?: string; queued?: true; heldFor?: 'compaction'; attachment?: { type?: string; commandMode?: string; sentAt?: string; deliveredAt?: string } }
  children: React.ReactNode
}): React.ReactNode {
  const role: MessageRole =
    message?.type === 'assistant' ||
    message?.type === 'grouped_tool_use' ||
    message?.type === 'collapsed_read_search'
      ? 'assistant'
      : 'user'
  const queued = message?.queued === true
  const delivery = !queued && message.attachment?.type === 'queued_command' && message.attachment.commandMode === 'task-notification' ? message.attachment.deliveredAt : undefined
  const sentMs = Date.parse(message.attachment?.sentAt ?? '')
  const deliveryMs = Date.parse(delivery ?? '')
  const timestamp = delivery !== undefined && Number.isFinite(deliveryMs) && (!Number.isFinite(sentMs) || deliveryMs >= sentMs) ? delivery : message?.timestamp
  const heldFor = queued && message?.heldFor === 'compaction' ? ('compaction' as const) : undefined
  const attachedClassify = React.useContext(AttachedAttributionContext)
  const attachedAuthor: AttachedAuthor | undefined =
    attachedClassify !== null ? (role === 'assistant' ? 'agent' : attachedClassify(message)) : undefined
  const value = React.useMemo<MessageMeta>(
    () => ({ timestamp, role, attachedAuthor, queued, ...(heldFor !== undefined ? { heldFor } : {}) }),
    [timestamp, role, attachedAuthor, queued, heldFor],
  )
  return (
    <MessageMetaContext.Provider value={value}>
      {children}
    </MessageMetaContext.Provider>
  )
}

let cachedHandle: string | null = null
export function userHandle(): string {
  if (cachedHandle !== null) return cachedHandle
  let h = flagEnv('MERCURY_OPERATOR')?.trim() ?? ''
  if (!h) {
    try {
      h = os.userInfo().username
    } catch {
      h = ''
    }
  }
  if (!h) h = (process.env.USER ?? process.env.LOGNAME ?? 'you').trim()
  const handle = truncateToWidth(h, 16) || 'you'
  cachedHandle = handle
  return handle
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`)

export const QUEUED_PLATE = 'queued'.padEnd(8)
export const HELD_PLATE = 'held'.padEnd(8)
export const HELD_FOR_COMPACTION_LINE = 'held until the compaction lands — it delivers once, on its own (↑ takes it back)'
const plateOf = (meta: { queued?: boolean; heldFor?: 'compaction' }): string => (meta.heldFor === 'compaction' ? HELD_PLATE : QUEUED_PLATE)

export type ClockColumnMeta = { timestamp?: string; queued?: boolean; heldFor?: 'compaction' }

export function clockColumnOf(meta: ClockColumnMeta, grammar: 'plate' | 'notice'): string | null {
  const clock = formatClock(meta.timestamp)
  if (meta.queued !== true) return clock === null ? null : `${clock} `
  if (grammar === 'plate') return `${plateOf(meta)} `
  return `${HELD_PLATE} ${meta.heldFor !== 'compaction' && clock !== null ? `since ${clock} ` : ''}`
}

export function formatClock(ts?: string): string | null {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function NameplateClock(): React.ReactNode {
  const meta = React.useContext(MessageMetaContext)
  if (!meta) return null
  const column = clockColumnOf(meta, 'notice')
  if (column === null) return null
  return <Text color={FAINT}>{column}</Text>
}

export function TranscriptNameplate(): React.ReactNode {
  const meta = React.useContext(MessageMetaContext)
  const isContinuation = React.useContext(NameplateContinuationContext)
  const critter = useSessionAccent()
  const { accentSoft: userBloom } = useMercuryTokens()
  const paneAccent = React.useContext(NameplateAccentContext)
  const crewmatePlate = React.useContext(CrewmatePlateContext)

  if (!meta) return null
  if (isContinuation) return null
  const clock = formatClock(meta.timestamp)
  if (!clock && !meta.attachedAuthor && crewmatePlate === null) return null
  const isAgent = meta.role === 'assistant'
  let name: string
  let nameColor: string
  if (crewmatePlate !== null) {
    name = isAgent ? crewmatePlate.agent : crewmatePlate.user
    nameColor = isAgent ? (paneAccent ?? critter.accent) : userBloom
  } else if (meta.attachedAuthor) {
    name = attachedPlateName(meta.attachedAuthor)
    nameColor =
      meta.attachedAuthor === 'agent'
        ? (paneAccent ?? critter.accent)
        : meta.attachedAuthor === 'coordinator'
          ? TEAL
          : meta.attachedAuthor === 'saturn' || meta.attachedAuthor === 'advisor'
            ? FAINT
            : userBloom
  } else {
    name = isAgent ? 'Mercury' : userHandle()
    nameColor = isAgent ? critter.accent : userBloom
  }
  const column = clockColumnOf(meta, 'plate')
  return (
    <Text>
      {column === null ? null : <Text color={FAINT}>{column}</Text>}
      <Text color={FAINT}>[</Text>
      <Text color={nameColor}>{name}</Text>
      <Text color={FAINT}>] </Text>
    </Text>
  )
}
