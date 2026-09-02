// ============================================================================
//  engine-connector/seatLive — the LIVE-TURN VIEW of a daemon-hosted focused
//  chat, beyond the connector's doors: what the chat's spinner, its working
//  strip and its status row paint while the session runs somewhere else.
//
//  The in-process engine hosts its own live state inside the chat screen
//  (the stream mode, the in-progress tool uses, the turn clock). A
//  daemon-hosted session folds the same view from its own records; the
//  connector exposes it through this extension so the face reads ONE shape
//  whichever engine carries the focused chat. No daemon import lives here —
//  the chat screen imports this module statically.
// ============================================================================
import type { EngineConnectorV1 } from './types.js'
import type { StreamingTailStore } from '../../utils/messages/streamingTailStore.js'

export interface SessionLiveV1 {
  inFlight: boolean
  /** 'compacting' is the fold's own state word (the runner stamps it through
   *  the tail projection while the summary call runs) — the face paints it
   *  as its own mechanical dress, never the thinking one. */
  phase: 'thinking' | 'tool' | 'responding' | 'compacting' | 'idle'
  inProgressToolUseIDs: Set<string>
  turnStartedAtMs: number | null
}

/** The focused chat's status sentence, as the status row speaks it.
 *
 *  LIVENESS (the one owner): the connector folds the seat's stamps of the
 *  runner's own frames into the four facts below; the row speaks them and
 *  claims nothing they do not carry. Transcript growth is NOT liveness — a
 *  long think, a long tool run and a real hang all leave the file still —
 *  and no field here reads it. */
export interface SeatStatusV1 {
  /** The session's title (the record's) and its project label. */
  title: string
  projectLabel: string
  /** An interrupt is on its way through the daemon. */
  interrupting: boolean
  /** ms since the session's runner last spoke — its last frame of ANY kind
   *  (a thinking delta with no text, a ping, a text delta, a tool_use
   *  start, a tool progress tick, a landed result). Null when no turn is in
   *  flight, when the runner has not spoken yet this seat-life, or when the
   *  runner predates the stamp (an old daemon: the row claims nothing). */
  quietMs: number | null
  /** The stream idle budget the runner's OWN watchdog aborts at (the api
   *  layer's number, reported in the runner's facts answer); null when the
   *  runner predates the field. */
  watchdogMs: number | null
  /** How long the current phase has stood: the streaming block's own clock
   *  (thinking / replying), the running tool's elapsed time, the turn's age
   *  in the dispatch wait. Null when idle or unknown. */
  phaseMs: number | null
  /** The running tool's own deadline budget (a shell's effective timeout),
   *  when its progress tick carried one; null otherwise. */
  toolBudgetMs: number | null
  /** THE STUCK VERDICT: true only while a turn is in flight, no tool is
   *  running (a tool's silence is the tool's, measured against its own
   *  budget), and the stream has carried no event for at least the
   *  watchdog's own warning half (streamIdleBudget.streamIdleWarningMsOf —
   *  the same rule the watchdog logs its warning by). Never true on a
   *  runner that reports no budget or no stamp. */
  stuck: boolean
  isolation?: 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'
  branchLabel?: string
}

/** The extension a daemon-hosted session's connector carries. */
export interface SeatLiveExtensionV1 {
  live(): SessionLiveV1
  subscribeLive(listener: () => void): () => void
  status(): SeatStatusV1
  /** The session's live tail — the reply's text block as it streams, fed
   *  from the daemon's tail projection into the same store shape the
   *  streaming reveal paints from. */
  tail(): StreamingTailStore
  /** Cumulative characters the IN-FLIGHT turn has streamed (the tail
   *  projection's turnChars — the live token counter's source). 0 when idle
   *  or when the seat predates the field (the mixed-version law: absence
   *  shows nothing, never a lie). Optional so older connector shapes stay
   *  valid; read through the focused selector, never assumed. */
  turnChars?(): number
}

export function hasSeatLive(
  connector: EngineConnectorV1,
): connector is EngineConnectorV1 & SeatLiveExtensionV1 {
  const c = connector as Partial<SeatLiveExtensionV1>
  return typeof c.live === 'function' && typeof c.subscribeLive === 'function' && typeof c.status === 'function' && typeof c.tail === 'function'
}

export const IDLE_LIVE: SessionLiveV1 = Object.freeze({
  inFlight: false,
  phase: 'idle',
  inProgressToolUseIDs: new Set<string>(),
  turnStartedAtMs: null,
}) as SessionLiveV1
