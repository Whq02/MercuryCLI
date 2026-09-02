
export interface NeedsYouJumpFacts {
  plain: boolean
  ownOnly: boolean
  boardChord: string
}

export function needsYouJump(facts: NeedsYouJumpFacts): string {
  if (!facts.plain) return `${facts.boardChord} board`
  return facts.ownOnly ? 'this chat' : '/resume'
}
