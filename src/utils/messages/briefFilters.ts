
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

export function filterForBriefTool<T extends BriefFilterMessage>(
  messages: T[],
  briefToolNames: string[],
): T[] {
  const nameSet = new Set(briefToolNames)
  const { msgTurn, turnsWithBrief } = mapBriefTurns(messages, nameSet)
  const briefToolUseIDs = new Set<string>()
  return messages.filter((msg, i) => {
    if (msg.type === 'system') return msg.subtype !== 'api_metrics'
    const blocks = msg.message?.content ?? []
    if (msg.type === 'assistant') {
      if (msg.isApiErrorMessage) return true
      const briefBlock = blocks.find(
        b => b.type === 'tool_use' && b.name && nameSet.has(b.name),
      )
      if (briefBlock) {
        if ('id' in briefBlock) {
          briefToolUseIDs.add((briefBlock as { id: string }).id)
        }
        return true
      }
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
      return !msg.isMeta
    }
    if (msg.type === 'attachment') {
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

export function dropTextInBriefTurns<T extends BriefFilterMessage>(
  messages: T[],
  briefToolNames: string[],
): T[] {
  const nameSet = new Set(briefToolNames)
  const { msgTurn, turnsWithBrief } = mapBriefTurns(messages, nameSet)
  if (turnsWithBrief.size === 0) return messages
  return messages.filter((msg, i) => {
    if (msg.type !== 'assistant') return true
    const blocks = Array.isArray(msg.message?.content) ? msg.message.content : []
    if (!blocks.some(b => b.type === 'text')) return true
    return !turnsWithBrief.has(msgTurn[i]!)
  })
}

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
