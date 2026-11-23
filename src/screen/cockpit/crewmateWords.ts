export const LEAD_ROW_NAME = 'Mercury Lead'
const MAIN_CHAT_WORD = 'main chat'
const VIEWING_WORD = 'viewing'
export const CREW_MAIN_CHAT_KEY = 'm main chat'
export const CREW_OPEN_IN_VIEW_KEY = '↵ open in the view'
export const MAIN_CHAT_CARD_LINE = 'THE MAIN CHAT — what you type goes to this agent'
const MAIN_CHAT_RETURN_HINT = `m on ${LEAD_ROW_NAME} returns the ${MAIN_CHAT_WORD}`
const MAIN_CHAT_HAND_BACK_HINT = `m on ${LEAD_ROW_NAME} hands the ${MAIN_CHAT_WORD} back`
export const BACK_HINT = `${LEAD_ROW_NAME} in the rail goes back`
export const COMPACT_BACK_HINT = `${LEAD_ROW_NAME} in the activity screen goes back`
const ESC_INTERRUPT_HINT = 'esc interrupts'
const ESC_BACK_HINT = `esc back to ${LEAD_ROW_NAME}`
export const CREW_CLEAR_KEY = 'c clear'
export const CREW_VIEW_DOOR = '/crewmates'
export const CREW_CLEAR_DOOR = `${CREW_CLEAR_KEY} in ${CREW_VIEW_DOOR}`

type CrewmateWordsState = { name: string; pinned: boolean; live?: boolean; local?: boolean }

export function crewmateHeaderTail(state: CrewmateWordsState): string {
  return `· ${state.name} · ${state.pinned ? MAIN_CHAT_WORD : VIEWING_WORD}`
}

const CREW_BOARD_STOP_PAUSE_KEYS = `x x stop · p pause in ${CREW_VIEW_DOOR}`

const CREW_BOARD_KEYS_LIVE = `in ${CREW_VIEW_DOOR}: ${CREW_MAIN_CHAT_KEY} · x x stop · p pause`
const CREW_BOARD_KEYS_LANDED = `in ${CREW_VIEW_DOOR}: ${CREW_MAIN_CHAT_KEY} · ${CREW_CLEAR_KEY}`

export function crewmateCardKeys(pinned: boolean, live = true, back = BACK_HINT): string {
  if (!live) return pinned ? `${ESC_BACK_HINT} · ${MAIN_CHAT_HAND_BACK_HINT} · ${CREW_CLEAR_DOOR}` : `${ESC_BACK_HINT} · ${CREW_BOARD_KEYS_LANDED} · ${back}`
  return pinned ? `${ESC_INTERRUPT_HINT} · ${MAIN_CHAT_HAND_BACK_HINT} · ${CREW_BOARD_STOP_PAUSE_KEYS}` : `${ESC_INTERRUPT_HINT} · ${CREW_BOARD_KEYS_LIVE} · ${back}`
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

type CrewmateViewedState = { name: string; live?: boolean } | null

export function crewmateStatusWords(viewed: CrewmateViewedState, target: CrewmateWordsState, running: number): string {
  const tail = ` · ${running} crewmate${running === 1 ? '' : 's'} running`
  if (viewed === null || viewed.name === target.name) {
    return target.pinned
      ? `${MAIN_CHAT_WORD}: ${target.name} · commands → ${target.name} · ${LEAD_ROW_NAME} waits in the rail${tail}`
      : `${VIEWING_WORD} ${target.name} · composer → ${target.name} · commands → ${target.name}${tail}`
  }
  return `${VIEWING_WORD} ${viewed.name} · commands → ${viewed.name} · composer → ${target.name} (the ${MAIN_CHAT_WORD})${tail}`
}

export function crewmateNextTurnWords(model: string | null, effort: string | null): string {
  const words = [model, effort].filter((part): part is string => part !== null && part !== '')
  return words.length === 0 ? '' : ` → ${words.join(' · ')} next turn`
}

export function crewmateGlobalCommandWords(command: string, name: string): string {
  return `/${command} runs for this session, not ${name}`
}

export function crewmateUnknownCommandWords(bareName: string, name: string, literal: string): string {
  return `Unknown command: /${bareName} — commands run for ${name} or for this session; ${literal} sends the line to the agent as text`
}

export function crewmateThinkingKeyWords(name: string, key: string): string {
  return `thinking stays as ${name} was spawned; /effort at ${name} sets its effort; ${key} is ${LEAD_ROW_NAME}'s — press it from the Lead`
}

export function crewmateCompactNothingWords(name: string, line: string): string {
  return `${name} — the crew view's /compact folded nothing: ${line}`
}

export function crewmateModelSwitchWords(name: string, label: string, running: boolean): string {
  return running ? `${name} switches to ${label} at its next turn` : `${label} recorded for ${name}'s next resume`
}

export function crewmateModelKeptWords(name: string, label: string): string {
  return `${name} stays on ${label}`
}

export function crewmateModelCurrentWords(name: string, label: string, next: string | null): string {
  return next === null ? `${name} runs ${label}` : `${name} runs ${label} · switches to ${next} at its next turn`
}

export function crewmateModelPickerLine(name: string, running: boolean): string {
  return running ? `${name} — a pick switches it at its next turn` : `${name} — a pick is recorded for its next resume`
}

export function crewmateEffortSwitchWords(name: string, level: string, running: boolean): string {
  return running ? `${name} runs ${level} from its next turn` : `effort ${level} recorded for ${name}'s next resume`
}

export function crewmateEffortClearedWords(name: string, running: boolean): string {
  return running ? `${name} runs its model's default effort from its next turn` : `${name}'s effort returns to its model's default at its next resume`
}

export function crewmateEffortCurrentWords(name: string, level: string | null, model: string, levels: readonly string[]): string {
  const choice = levels.length > 0 ? ` — /effort ${levels.join('|')} sets it` : ''
  return level === null ? `${name} runs ${model}'s default effort${choice}` : `${name} runs ${level} on ${model}${choice}`
}

export function crewmateEffortRefusedWords(name: string, level: string, model: string, levels: readonly string[]): string {
  return `${name}'s ${model} does not serve ${level} — ${levels.length > 0 ? `it takes ${levels.join(' | ')}` : 'it takes no effort setting'}; nothing was recorded`
}

export function crewmateCompactWords(name: string, running: boolean): string {
  return running ? `${name} compacts at its next turn` : `${name} compacts when it resumes`
}

export function crewmateNumbersUnreportedWords(name: string): string {
  return `${name} has not reported its numbers yet — no request of its own has settled`
}

export function crewmateContextWords(name: string, model: string, context: string, window: string | null, pct: number | null): string {
  const fill = window === null ? `${context} tokens of context` : `context ${context} of ${window}${pct === null ? '' : ` (${pct}%)`}`
  return `${name} · ${model} · ${fill}`
}

export function crewmateUsageWords(name: string, model: string, facts: { input: string; output: string; cached: string | null; cost: string; toolUses: number | null; elapsed: string }): string {
  const tokens = [`${facts.input} in`, `${facts.output} out`, ...(facts.cached === null ? [] : [`${facts.cached} cached`])].join(' · ')
  const tools = facts.toolUses === null ? '' : ` · ${facts.toolUses} tool use${facts.toolUses === 1 ? '' : 's'}`
  return `${name} · ${model} · ${tokens} · ${facts.cost}${tools} · ${facts.elapsed}`
}

export function crewmateCommandUnreachableWords(name: string, command: string): string {
  return `/${command} could not reach ${name}'s record — nothing changed`
}

export function crewmateSendClause(target: CrewmateWordsState): string {
  if (target.live !== false) return `↵ sends to ${target.name}`
  return target.local === true ? `↵ refused — r in ${CREW_VIEW_DOOR} resumes ${target.name}` : `↵ resumes ${target.name} with your line`
}

export function crewmateComposerHint(target: CrewmateWordsState, viewed: CrewmateViewedState): string {
  const esc = viewed === null ? '' : viewed.live === false ? ` · ${ESC_BACK_HINT}` : ` · esc interrupts ${viewed.name}`
  return `${crewmateSendClause(target)}${esc} · ${target.pinned ? MAIN_CHAT_RETURN_HINT : BACK_HINT}`
}

export const CREWMATE_BETWEEN_TURNS_DETAIL = `it is between turns and nothing drains a queued line — r in ${CREW_VIEW_DOOR} resumes it from its transcript`

export function crewmateInterruptRefusedWords(name: string, detail: string): string {
  return `${name} did not take the interrupt: ${detail}`
}

export function crewmateStatusRightHint(pinned: boolean, live = true, escapeOwned = false): string {
  const esc = escapeOwned ? '' : live ? ESC_INTERRUPT_HINT : ESC_BACK_HINT
  return pinned ? esc : [esc, `${CREW_MAIN_CHAT_KEY} in ${CREW_VIEW_DOOR}`, BACK_HINT].filter(Boolean).join(' · ')
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
