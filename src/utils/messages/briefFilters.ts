// =============================================================================
// briefFilters — the brief-mode transcript filters + the trailing-recap
// detector, extracted from Messages.tsx into a LEAF so
// scripts/messages/prove-brief-filters.ts exercises the REAL functions
// (Messages.tsx itself is not bun-loadable).
//
// The swallowed-first-reply guard lives here:
// a brief filter that drops ALL assistant text ("if the model forgets
// to call SendUserMessage, the user sees nothing for that turn — that's on
// the model to get right") loses real replies: the
// operator asks "reply with test 1", the model answers in plain text, the
// stop-hook nag fires, the model doesn't act — and the reply vanishes. The
// renderer-side FALLBACK makes the miss mechanically impossible: a turn that
// never called the Brief tool keeps its plain text (it IS the reply); turns
// that did call it keep the clean Brief-only surface.
// =============================================================================

type BriefFilterMessage = {
  type: string
  subtype?: string
  isMeta?: boolean
  isApiErrorMessage?: boolean
  message?: {
    content: Array<{
      type: string
      name?: string
      tool_use_id?: string
      text?: string
    }>
  }
  attachment?: {
    type: string
    isMeta?: boolean
    origin?: unknown
    commandMode?: string
  }
}

/** The turn-boundary rule both filters share: a REAL user message (not a
 *  tool_result carrier, not meta) opens a new turn. */
function isTurnBoundary(msg: {
  type: string
  isMeta?: boolean
  message?: { content: Array<{ type: string }> }
}): boolean {
  const blocks = Array.isArray(msg.message?.content) ? msg.message.content : []
  return (
    msg.type === 'user' &&
    !blocks.some(b => b.type === 'tool_result') &&
    !msg.isMeta
  )
}

/** Map each message index to its turn ordinal + the set of turns that called
 *  the Brief tool. Scans ALL blocks (a [text@0, tool_use@1] turn must count). */
function mapBriefTurns<T extends BriefFilterMessage>(
  messages: T[],
  nameSet: ReadonlySet<string>,
): { msgTurn: number[]; turnsWithBrief: Set<number> } {
  const msgTurn: number[] = []
  const turnsWithBrief = new Set<number>()
  let turn = 0
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (isTurnBoundary(msg)) turn++
    msgTurn[i] = turn
    if (msg.type !== 'assistant') continue
    const blocks = Array.isArray(msg.message?.content) ? msg.message.content : []
    if (blocks.some(b => b.type === 'tool_use' && b.name && nameSet.has(b.name))) {
      turnsWithBrief.add(turn)
    }
  }
  return { msgTurn, turnsWithBrief }
}

/**
 * In brief-only mode, show ONLY Brief tool_use blocks, their tool_results,
 * real user input — and, since, the RENDERER-SIDE FALLBACK: the
 * plain text of turns that never called the Brief tool. Without the fallback
 * a model slip swallowed the whole reply (the operator's "reply with test 1"
 * rendered nothing); with it, a briefless turn's text is promoted as the
 * reply while brief turns keep the clean single-surface look. Mid-turn the
 * promotion self-heals: if the model calls Brief later in the same turn, the
 * turn joins turnsWithBrief and its interim text folds away.
 */
export function filterForBriefTool<T extends BriefFilterMessage>(
  messages: T[],
  briefToolNames: string[],
): T[] {
  const nameSet = new Set(briefToolNames)
  const { msgTurn, turnsWithBrief } = mapBriefTurns(messages, nameSet)
  // One forward pass suffices for id matching: a tool_result can only
  // appear AFTER its tool_use in the array, so ids collected on the way
  // down are complete by the time their results arrive.
  const briefToolUseIDs = new Set<string>()
  return messages.filter((msg, i) => {
    // System messages stay (attach confirmations, remote errors, compact
    // boundaries — dropping them would leave the viewer with no feedback),
    // with ONE exception: api_metrics is per-turn debug noise that defeats
    // brief mode's point. Transcript mode (ctrl+o) bypasses this filter and
    // still shows it.
    if (msg.type === 'system') return msg.subtype !== 'api_metrics'
    // Scan ALL blocks, not just content[0]: a [text@0, Brief tool_use@1] turn would
    // otherwise be dropped whole (block[0]=text ⇒ not a Brief tool_use), taking the
    // Brief block with it. find() over every block keeps the Brief tool_use + its result.
    const blocks = msg.message?.content ?? []
    if (msg.type === 'assistant') {
      // API errors (auth failures, rate limits) always render.
      if (msg.isApiErrorMessage) return true
      // A Brief tool_use renders with standard tool chrome — and must stay
      // in the list so buildMessageLookups can pair its tool_result.
      const briefBlock = blocks.find(
        b => b.type === 'tool_use' && b.name && nameSet.has(b.name),
      )
      if (briefBlock) {
        if ('id' in briefBlock) {
          briefToolUseIDs.add((briefBlock as { id: string }).id)
        }
        return true
      }
      // The fallback: a briefless turn's text IS the reply — keep it.
      // (Work-noise messages — pure tool_use batches — stay hidden.)
      if (
        !turnsWithBrief.has(msgTurn[i]!) &&
        blocks.some(b => b.type === 'text' && (b.text ?? '').trim().length > 0)
      ) {
        return true
      }
      return false
    }
    if (msg.type === 'user') {
      const trBlock = blocks.find(b => b.type === 'tool_result')
      if (trBlock) {
        return (
          trBlock.tool_use_id !== undefined &&
          briefToolUseIDs.has(trBlock.tool_use_id)
        )
      }
      // Non-tool-result user messages: only REAL input renders — meta and
      // tick messages fold away.
      return !msg.isMeta
    }
    if (msg.type === 'attachment') {
      // Human input drained mid-turn arrives as a queued_command attachment
      // (query.ts mid-chain drain → getQueuedCommandAttachments). Keep it —
      // it's what the user typed. commandMode === 'prompt' positively
      // identifies human-typed input; task-notification callers set
      // mode: 'task-notification' but not origin/isMeta, so the positive
      // commandMode check is required to exclude them.
      const att = msg.attachment
      return (
        att?.type === 'queued_command' &&
        att.commandMode === 'prompt' &&
        !att.isMeta &&
        att.origin === undefined
      )
    }
    return false
  })
}

/**
 * Full-transcript companion to filterForBriefTool. When the Brief tool is
 * in use, the model's text output is redundant with the SendUserMessage
 * content it wrote right after — drop the text so only the SendUserMessage
 * block shows. Tool calls and their results stay visible.
 *
 * Per-turn: only drops text in turns that actually called Brief. If the
 * model forgets, text still shows — otherwise the user would see nothing.
 */
export function dropTextInBriefTurns<T extends BriefFilterMessage>(
  messages: T[],
  briefToolNames: string[],
): T[] {
  const nameSet = new Set(briefToolNames)
  // Pass one: map every message to its turn and mark the Brief-calling
  // turns — over ALL content blocks, not just content[0]. A turn shaped
  // [text@0, SendUserMessage tool_use@1] once tagged its text but was never
  // flagged a Brief turn (the tool_use sat at index 1), so the redundant
  // text never dropped — the second defect behind the double-message bug.
  const { msgTurn, turnsWithBrief } = mapBriefTurns(messages, nameSet)
  if (turnsWithBrief.size === 0) return messages
  // Pass two: text folds away exactly in the turns that called Brief.
  return messages.filter((msg, i) => {
    if (msg.type !== 'assistant') return true
    const blocks = Array.isArray(msg.message?.content) ? msg.message.content : []
    if (!blocks.some(b => b.type === 'text')) return true
    return !turnsWithBrief.has(msgTurn[i]!)
  })
}

/**
 * The trailing-recap detector: true when the
 * window contains a Brief tool_use followed — in a later block of the same
 * message or any later assistant message — by non-empty plain text. That
 * trailing text double-reports (the wrapper's STATUS-trailer doctrine
 * colliding with brief's one-surface rule); the stop hook teaches it away
 * once per session (BRIEF_RECAP_SENTINEL).
 */
export function hasTrailingTextAfterBrief(
  messages: ReadonlyArray<{
    type: string
    message?: { content?: unknown }
  }>,
  briefToolNames: string[],
): boolean {
  const nameSet = new Set(briefToolNames)
  let last: { m: number; b: number } | null = null
  const blocksOf = (
    msg: (typeof messages)[number],
  ): Array<{ type: string; name?: string; text?: string }> =>
    Array.isArray(msg.message?.content)
      ? (msg.message.content as Array<{ type: string; name?: string; text?: string }>)
      : []
  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m]!
    if (msg.type !== 'assistant') continue
    blocksOf(msg).forEach((blk, b) => {
      if (blk.type === 'tool_use' && blk.name && nameSet.has(blk.name)) {
        last = { m, b }
      }
    })
  }
  if (last === null) return false
  const at: { m: number; b: number } = last
  for (let m = at.m; m < messages.length; m++) {
    const msg = messages[m]!
    if (msg.type !== 'assistant') continue
    const blocks = blocksOf(msg)
    for (let b = m === at.m ? at.b + 1 : 0; b < blocks.length; b++) {
      const blk = blocks[b]!
      if (blk.type === 'text' && (blk.text ?? '').trim().length > 0) return true
    }
  }
  return false
}
