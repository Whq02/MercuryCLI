import os from 'node:os'
import * as React from 'react'
import { Text } from '../../ink.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isScribeModeOn } from '../../utils/scribeMode.js'
import { FAINT, TEAL } from '../mercuryPalette.js'
import { truncateToWidth } from '../mercury-ui/glyphs.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import {
  classifyAuthor,
  scribeStreamName,
  type ScribeAuthor,
} from '../mercury-ui/scribeChatTabs.js'

// ============================================================================
//  TranscriptNameplate — Mercury's per-message identity prefix.
//
//  Renders `HH:MM:SS [name] ` immediately BEFORE a message's existing glyph
//  (the `❯` user caret, the bulletless agent gutter, the tool bullet), so every
//  transcript line is stamped with WHEN it happened and WHO spoke without
//  disturbing the glyph column or the body. Honest by construction: the time is
//  derived from the message's REAL stored timestamp (set at message creation),
//  never Date.now() at render — a missing/unparseable stamp self-omits the
//  whole nameplate rather than inventing one.
//
//  Mercury-only. The role + timestamp arrive via MessageMetaContext (provided once
//  in the hand-written Message export wrapper), so the leaf renderers don't have
//  to thread a prop through the React-Compiler `_c` Message internals.
// ============================================================================

export type MessageRole = 'user' | 'assistant'

/** The attached/mirror surfaces' THREE-party vocabulary (operator ruling
 * inside a worker's transcript, rows attribute as the
 *  operator's own text, an instruction delivered through the coordinator
 *  door, or the worker's turns. Classification values only — the PAINTED
 *  names come from attachedPlateName. */
export type AttachedAuthor = 'user' | 'coordinator' | 'agent'

/** The ONE pure home of the plate vocabulary → painted-name map
 *  (mirror-agent-word): the worker's turns plate as
 *  Mercury — the classification value 'agent' is unreachable as painted
 *  output — the operator plates as the handle, coordinator deliveries as
 *  "coordinator". */
export function attachedPlateName(author: AttachedAuthor): string {
  // Operator-ruled: the plate reads [Coordinator], capitalized —
  // a NAME beside [Mercury] and the operator's handle, not a role word.
  return author === 'agent' ? 'Mercury' : author === 'coordinator' ? 'Coordinator' : userHandle()
}

/** Provided by the attached-session surface around its transcript: a pure
 *  classifier for USER-side rows (operator text vs coordinator-delivered
 *  instruction — the dispatch ledger's digest truth). null elsewhere ⇒
 *  default naming, byte-identical. */
export const AttachedAttributionContext = React.createContext<
  ((message: { type?: string }) => 'user' | 'coordinator') | null
>(null)

/** Per-surface identity ink for the Mercury (worker) plate: the switchboard
 *  mirror paints the SELECTED session's own identity accent (the caller
 *  resolves it). null ⇒ the app session's critter accent (default). */
export const NameplateAccentContext = React.createContext<string | null>(null)

type MessageMeta = {
  timestamp?: string
  role: MessageRole
  // In Scribe Mode, the stream this message belongs to (operator / Scribe /
  // Implementer) so the nameplate stamps [Mercury-Amanuensis] / [Mercury-Implement]
  // instead of a generic [Mercury]. undefined outside scribe mode ⇒ default naming.
  scribeAuthor?: ScribeAuthor
  // Inside the attached-session surface: the three-party attribution.
  attachedAuthor?: AttachedAuthor
}

const MessageMetaContext = React.createContext<MessageMeta | null>(null)

/** Read the current message's meta (timestamp/role/scribeAuthor), or null outside a
 *  Message. Lets sibling renderers (e.g. the relayed-teammate line in scribe mode)
 *  reuse the same honest stored timestamp the nameplate uses. */
export function useMessageMeta(): MessageMeta | null {
  return React.useContext(MessageMetaContext)
}

// True for an assistant message that CONTINUES the same turn as the message
// before it. The transcript stream splits a multi-block assistant turn into separate one-block
// messages that share a timestamp, so without this each split block would
// re-stamp `HH:MM:SS [Mercury]` mid-response. The nameplate stamps once at the
// turn's head; continuation messages omit it. Provided per-row in Messages.tsx,
// which is the layer that knows the previous message's type.
export const NameplateContinuationContext = React.createContext<boolean>(false)

// Provided once per message at the Message memo wrapper. role is derived from
// the discriminated message.type; anything that isn't an assistant turn is
// treated as the user's side (prompts, tool results, bash) so it carries the
// user handle. Cheap + memoized so it never re-renders consumers spuriously.
export function MessageMetaProvider({
  message,
  children,
}: {
  message: { type?: string; timestamp?: string }
  children: React.ReactNode
}): React.ReactNode {
  // Agent-side turns: the assistant proper AND its collapsed tool group (a
  // synthesized 'grouped_tool_use' message that carries the agent's action).
  // Everything else (prompts, tool results, bash, attachments) is the user side.
  const role: MessageRole =
    message?.type === 'assistant' ||
    message?.type === 'grouped_tool_use' ||
    message?.type === 'collapsed_read_search'
      ? 'assistant'
      : 'user'
  const timestamp = message?.timestamp
  // Scribe Mode: classify the stream so the nameplate can label the Scribe vs the
  // relayed Implementer distinctly. Agent-side turns the provider already groups
  // as 'assistant' (incl. tool groups) stay the Scribe even if classifyAuthor's
  // text heuristic would say 'operator' (a tool-only turn). Outside scribe mode ⇒
  // undefined ⇒ default [Mercury]/handle naming (byte-identical).
  let scribeAuthor: ScribeAuthor | undefined
  if (isScribeModeOn()) {
    scribeAuthor = classifyAuthor(message as Parameters<typeof classifyAuthor>[0])
    if (role === 'assistant' && scribeAuthor === 'operator') scribeAuthor = 'scribe'
  }
  // The attached-session surface speaks its three-party vocabulary — the
  // surface provides the user/coordinator classifier; agent-side turns are
  // the worker itself.
  const attachedClassify = React.useContext(AttachedAttributionContext)
  const attachedAuthor: AttachedAuthor | undefined =
    attachedClassify !== null ? (role === 'assistant' ? 'agent' : attachedClassify(message)) : undefined
  const value = React.useMemo<MessageMeta>(
    () => ({ timestamp, role, scribeAuthor, attachedAuthor }),
    [timestamp, role, scribeAuthor, attachedAuthor],
  )
  return (
    <MessageMetaContext.Provider value={value}>
      {children}
    </MessageMetaContext.Provider>
  )
}

// The operator's display handle. MERCURY_OPERATOR names you (the same
// designed override getOperatorName() honors — the seat rail, /say and this
// nameplate must agree on who the operator is), else the OS login handle,
// else $USER/$LOGNAME, else a neutral 'you'. Resolved once, never throws.
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
  // WIDTH: display-width truncation — $USER/$LOGNAME is not guaranteed ASCII,
  // and this handle prefixes every user turn (misalignment would be session-wide).
  const handle = truncateToWidth(h, 16) || 'you'
  cachedHandle = handle
  return handle
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`)

// HH:MM:SS, local 24h, from the message's stored timestamp. Returns null for a
// missing/unparseable stamp so the caller renders no prefix (never a guess).
export function formatClock(ts?: string): string | null {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

// A single inline <Text> so it composes BOTH ways: nested inside a parent <Text>
// (the user caret line) and as a row child (the agent/tool rows), always landing
// in front of the existing glyph. Time + brackets are FAINT meta; the name
// carries identity — full critter accent for Mercury, the cooler accent→ivory
// tint (same as the user-turn caret/text) for your own handle.
export function TranscriptNameplate(): React.ReactNode {
  const meta = React.useContext(MessageMetaContext)
  const isContinuation = React.useContext(NameplateContinuationContext)
  const critter = useSessionAccent()
  // The ONE derived accent-bloom — the operator handle's tint,
  // matching the composer's typed-text color exactly.
  const { accentSoft: userBloom } = useMercuryTokens()
  const paneAccent = React.useContext(NameplateAccentContext)

  if (!meta) return null
  // Same-turn continuation (e.g. a split long-answer + recap): the turn was
  // already stamped on its first message — don't re-stamp mid-response.
  if (isContinuation) return null
  const clock = formatClock(meta.timestamp)
  // Outside scribe mode, keep the honest self-omit (no fabricated stamp ⇒ no
  // nameplate). In SCRIBE mode the [name] is IDENTITY (role-derived, never
  // invented), so always show it — only the HH:MM:SS self-omits when the stored
  // timestamp is missing. This keeps every Scribe turn tagged [Mercury-Amanuensis] /
  // [Mercury-Implement] consistently, even a turn that lacks a stored stamp (which
  // otherwise renders as a bare, un-attributed dump).
  // The attached surface's plates are IDENTITY (role/ledger-derived, never
  // invented) — like the scribe plates they always show; only the clock
  // self-omits on a missing stored stamp.
  if (!clock && !meta.scribeAuthor && !meta.attachedAuthor) return null
  const isAgent = meta.role === 'assistant'
  // Attached session: the ruled three-party vocabulary. Scribe Mode:
  // distinct identity + colour per stream (Scribe = accent, Implementer =
  // TEAL, matching the deck chat-tabs); else the default naming.
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
  } else if (meta.scribeAuthor) {
    name = scribeStreamName(meta.scribeAuthor, userHandle())
    nameColor =
      meta.scribeAuthor === 'scribe'
        ? critter.accent
        : meta.scribeAuthor === 'implement'
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
