import os from 'node:os'
import * as React from 'react'
import { Text } from '../../ink.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { FAINT, TEAL } from '../mercuryPalette.js'
import { truncateToWidth } from '../mercury-ui/glyphs.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'


export type MessageRole = 'user' | 'assistant'

export type AttachedAuthor = 'user' | 'coordinator' | 'agent'

export function attachedPlateName(author: AttachedAuthor): string {
  return author === 'agent' ? 'Mercury' : author === 'coordinator' ? 'Coordinator' : userHandle()
}

export const AttachedAttributionContext = React.createContext<
  ((message: { type?: string }) => 'user' | 'coordinator') | null
>(null)

export const NameplateAccentContext = React.createContext<string | null>(null)

type MessageMeta = {
  timestamp?: string
  role: MessageRole
  attachedAuthor?: AttachedAuthor
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
  message: { type?: string; timestamp?: string }
  children: React.ReactNode
}): React.ReactNode {
  const role: MessageRole =
    message?.type === 'assistant' ||
    message?.type === 'grouped_tool_use' ||
    message?.type === 'collapsed_read_search'
      ? 'assistant'
      : 'user'
  const timestamp = message?.timestamp
  const attachedClassify = React.useContext(AttachedAttributionContext)
  const attachedAuthor: AttachedAuthor | undefined =
    attachedClassify !== null ? (role === 'assistant' ? 'agent' : attachedClassify(message)) : undefined
  const value = React.useMemo<MessageMeta>(
    () => ({ timestamp, role, attachedAuthor }),
    [timestamp, role, attachedAuthor],
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

export function formatClock(ts?: string): string | null {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function TranscriptNameplate(): React.ReactNode {
  const meta = React.useContext(MessageMetaContext)
  const isContinuation = React.useContext(NameplateContinuationContext)
  const critter = useSessionAccent()
  const { accentSoft: userBloom } = useMercuryTokens()
  const paneAccent = React.useContext(NameplateAccentContext)

  if (!meta) return null
  if (isContinuation) return null
  const clock = formatClock(meta.timestamp)
  if (!clock && !meta.attachedAuthor) return null
  const isAgent = meta.role === 'assistant'
  let name: string
  let nameColor: string
  if (meta.attachedAuthor) {
    name = attachedPlateName(meta.attachedAuthor)
    nameColor =
      meta.attachedAuthor === 'agent'
        ? (paneAccent ?? critter.accent)
        : meta.attachedAuthor === 'coordinator'
          ? TEAL
          : userBloom
  } else {
    name = isAgent ? 'Mercury' : userHandle()
    nameColor = isAgent ? critter.accent : userBloom
  }
  return (
    <Text>
      {clock ? <Text color={FAINT}>{clock} </Text> : null}
      <Text color={FAINT}>[</Text>
      <Text color={nameColor}>{name}</Text>
      <Text color={FAINT}>] </Text>
    </Text>
  )
}
