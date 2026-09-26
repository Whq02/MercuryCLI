export const LEAD_ROW_NAME = 'Mercury Lead'
export const MAIN_CHAT_WORD = 'main chat'
export const VIEWING_WORD = 'viewing'
export const CREW_MAIN_CHAT_KEY = 'm main chat'
export const CREW_OPEN_IN_VIEW_KEY = '↵ open in the view'
export const MAIN_CHAT_CARD_LINE = 'THE MAIN CHAT — what you type goes to this agent'
export const MAIN_CHAT_RETURN_HINT = `m on ${LEAD_ROW_NAME} returns the ${MAIN_CHAT_WORD}`
export const MAIN_CHAT_HAND_BACK_HINT = `m on ${LEAD_ROW_NAME} hands the ${MAIN_CHAT_WORD} back`
export const BACK_HINT = `${LEAD_ROW_NAME} in the rail goes back`
export const ESC_INTERRUPT_HINT = 'esc interrupts'
export const ESC_BACK_HINT = `esc back to ${LEAD_ROW_NAME}`
export const CREW_CLEAR_KEY = 'c clear'
export const CREW_CLEAR_DOOR = `${CREW_CLEAR_KEY} in /teammates`

export type CrewmateWordsState = { name: string; pinned: boolean }

export function crewmateHeaderGlyph(pinned: boolean): '★' | '✶' {
  return pinned ? '★' : '✶'
}

export function crewmateHeaderTail(state: CrewmateWordsState): string {
  return `· ${state.name} · ${state.pinned ? MAIN_CHAT_WORD : VIEWING_WORD}`
}

export function crewmateCardKeys(pinned: boolean, live = true): string {
  if (!live) return pinned ? `${ESC_BACK_HINT} · ${MAIN_CHAT_HAND_BACK_HINT} · ${CREW_CLEAR_DOOR}` : `${ESC_BACK_HINT} · ${CREW_MAIN_CHAT_KEY} · ${CREW_CLEAR_DOOR} · ${BACK_HINT}`
  return pinned ? `${ESC_INTERRUPT_HINT} · ${MAIN_CHAT_HAND_BACK_HINT} · x stop · p pause` : `${ESC_INTERRUPT_HINT} · ${CREW_MAIN_CHAT_KEY} · x stop · p pause · ${BACK_HINT}`
}

export function crewClearedWords(name: string): string {
  return `${name} cleared — its row is gone; its transcript stays on disk`
}

export function crewClearRefusedWords(facts: { name: string; running: boolean }): string {
  return facts.running
    ? `${facts.name} is running — x x stops it; only a finished row clears`
    : `${facts.name} is paused — it resumes by itself; it clears once it lands`
}

export function crewmateEscBackWords(name: string, state: string): string {
  return `${name} is ${state} — back on ${LEAD_ROW_NAME}; its row stays in the CREW box until you clear it`
}

export type CrewmateViewedState = { name: string; live?: boolean } | null

export function crewmateStatusWords(viewed: CrewmateViewedState, target: CrewmateWordsState, running: number): string {
  const tail = ` · ${running} agent${running === 1 ? '' : 's'} running`
  if (viewed === null || viewed.name === target.name) {
    return target.pinned
      ? `${MAIN_CHAT_WORD}: ${target.name} · ${LEAD_ROW_NAME} waits in the rail${tail}`
      : `${VIEWING_WORD} ${target.name} · composer → ${target.name}${tail}`
  }
  return `${VIEWING_WORD} ${viewed.name} · composer → ${target.name} (the ${MAIN_CHAT_WORD})${tail}`
}

export function crewmateComposerHint(target: CrewmateWordsState, viewed: CrewmateViewedState): string {
  const esc = viewed === null ? '' : viewed.live === false ? ` · ${ESC_BACK_HINT}` : ` · esc interrupts ${viewed.name}`
  return `↵ sends to ${target.name}${esc} · ${target.pinned ? MAIN_CHAT_RETURN_HINT : BACK_HINT}`
}

export const CREWMATE_BETWEEN_TURNS_DETAIL = 'it is between turns and nothing drains a queued line — r in /teammates resumes it from its transcript'

export function crewmateInterruptRefusedWords(name: string, detail: string): string {
  return `${name} did not take the interrupt: ${detail}`
}

export function crewmateEscHint(name: string): string {
  return `esc interrupt ${name}`
}

export function crewmateStatusRightHint(pinned: boolean, live = true): string {
  const esc = live ? ESC_INTERRUPT_HINT : ESC_BACK_HINT
  return pinned ? esc : `${esc} · ${CREW_MAIN_CHAT_KEY} in /teammates · ${BACK_HINT}`
}

export function crewmatePlaceholder(name: string): string {
  return `message ${name}`
}

export function operatorPlateName(name: string): string {
  return `you → ${name}`
}

export function operatorLinePlate(name: string): string {
  return `[${operatorPlateName(name)}]`
}

export function crewmateQueuedWords(name: string): string {
  return `queued to ${name} — it lands at the end of its turn`
}

export function crewmateLineRefusedNote(name: string, why: string): string {
  return `↳ ${name} did not take it: ${why}`
}

export function crewmateLineStrandedNote(name: string): string {
  return `↳ not delivered — ${name} ended before it landed`
}

export function crewmateResumedWords(name: string): string {
  return `${name} was between turns — it resumed with your message`
}

export function crewmateRefusedWords(name: string, detail: string): string {
  return `${name} did not take the message: ${detail} — the draft stays`
}

export function crewmateInterruptedWords(name: string): string {
  return `${name} interrupted — its turn is cut, ${LEAD_ROW_NAME} is told; a queued message lands as it stops`
}

export function crewmateIdleWords(name: string): string {
  return `${name} is between turns — nothing to interrupt; your next line resumes it`
}
