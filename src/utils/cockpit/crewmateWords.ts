export const LEAD_ROW_NAME = 'Mercury Lead'
export const MAIN_CHAT_WORD = 'main chat'
export const VIEWING_WORD = 'viewing'
export const CREW_MAIN_CHAT_KEY = 'm main chat'
export const CREW_OPEN_IN_VIEW_KEY = '↵ open in the view'
export const MAIN_CHAT_CARD_LINE = 'THE MAIN CHAT — what you type goes to this agent'
export const MAIN_CHAT_RETURN_HINT = `m on ${LEAD_ROW_NAME} returns the ${MAIN_CHAT_WORD}`
export const MAIN_CHAT_HAND_BACK_HINT = `m on ${LEAD_ROW_NAME} hands the ${MAIN_CHAT_WORD} back`
export const ESC_BACK_HINT = `esc back to ${LEAD_ROW_NAME}`

export type CrewmateWordsState = { name: string; pinned: boolean }

export function crewmateHeaderGlyph(pinned: boolean): '★' | '✶' {
  return pinned ? '★' : '✶'
}

export function crewmateHeaderTail(state: CrewmateWordsState): string {
  return `· ${state.name} · ${state.pinned ? MAIN_CHAT_WORD : VIEWING_WORD}`
}

export function crewmateCardKeys(pinned: boolean): string {
  return pinned ? `${MAIN_CHAT_HAND_BACK_HINT} · x stop · p pause` : `${CREW_MAIN_CHAT_KEY} · x stop · p pause · ${ESC_BACK_HINT}`
}

export function crewmateStatusWords(state: CrewmateWordsState, running: number): string {
  const tail = ` · ${running} agent${running === 1 ? '' : 's'} running`
  return state.pinned
    ? `${MAIN_CHAT_WORD}: ${state.name} · ${LEAD_ROW_NAME} waits in the rail${tail}`
    : `${VIEWING_WORD} ${state.name} · composer → ${state.name}${tail}`
}

export function crewmateComposerHint(state: CrewmateWordsState): string {
  return `↵ sends to ${state.name} · ${state.pinned ? MAIN_CHAT_RETURN_HINT : ESC_BACK_HINT}`
}

export function crewmateEscHint(pinned: boolean): string {
  return pinned ? 'esc interrupt' : 'esc back'
}

export function crewmateStatusRightHint(pinned: boolean): string {
  return pinned ? 'esc interrupts' : `${ESC_BACK_HINT} · ${CREW_MAIN_CHAT_KEY} in /teammates`
}

export function crewmatePlaceholder(name: string): string {
  return `message ${name}`
}

export function operatorLinePlate(name: string): string {
  return `[you → ${name}]`
}

export function crewmateQueuedWords(name: string): string {
  return `queued to ${name} — it lands at the end of its turn`
}

export function crewmateResumedWords(name: string): string {
  return `${name} was between turns — it resumed with your message`
}

export function crewmateRefusedWords(name: string, detail: string): string {
  return `${name} did not take the message: ${detail} — the draft stays`
}

export function crewmateInterruptedWords(name: string): string {
  return `${name} interrupted — a queued message lands as it stops`
}
