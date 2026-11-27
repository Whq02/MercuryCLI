export const LEAD_ROW_NAME = 'Mercury Lead'
export const CREW_MAIN_CHAT_KEY = 'm main chat'
export const CREW_OPEN_IN_VIEW_KEY = '↵ open in the view'
export const CREW_CLEAR_KEY = 'c clear'
export const CREW_VIEW_DOOR = '/crewmates'
export function crewClearedWords(name: string): string {
  return `${name} cleared — its transcript stays on disk`
}

export function crewClearRefusedWords(facts: { name: string; running: boolean }): string {
  return facts.running
    ? `${facts.name} is running — x x stops it; only a finished row clears`
    : `${facts.name} is paused — it resumes by itself; it clears once it lands`
}

export function crewmateEscBackWords(name: string, state: string): string {
  return `${name} is ${state} — back on ${LEAD_ROW_NAME}; its row stays in the crew panel until you clear it`
}

export function crewmateNextTurnWords(model: string | null, effort: string | null): string {
  const words = [model, effort].filter((part): part is string => part !== null && part !== '')
  return words.length === 0 ? '' : ` → ${words.join(' · ')} next turn`
}

export function crewmateThinkingKeyWords(name: string, key: string): string {
  return `thinking stays as ${name} was spawned; /effort at ${name} sets its effort; ${key} is ${LEAD_ROW_NAME}'s — press it from the Lead`
}

export function crewmateFoldNothingWords(name: string, line: string): string {
  return `${name} — the crew view's /compact folded nothing: ${line}`
}

export function crewmateModelSwitchWords(name: string, label: string, running: boolean): string {
  return running ? `${name} switches to ${label} at its next turn` : `${label} recorded for ${name}'s next resume`
}

export function crewmateModelCurrentWords(name: string, label: string, next: string | null): string {
  return next === null ? `${name} runs ${label}` : `${name} runs ${label} · switches to ${next} at its next turn`
}

export function crewmateEffortSwitchWords(name: string, level: string, running: boolean): string {
  return running ? `${name} runs ${level} from its next turn` : `effort ${level} recorded for ${name}'s next resume`
}

export function crewmateEffortClearedWords(name: string, running: boolean): string {
  return running ? `${name} runs its model's default effort from its next turn` : `${name}'s effort returns to its model's default at its next resume`
}

export function crewmateEffortRefusedWords(name: string, level: string, model: string, levels: readonly string[]): string {
  return `${name}'s ${model} does not serve ${level} — ${levels.length > 0 ? `it takes ${levels.join(' | ')}` : 'it takes no effort setting'}; nothing was recorded`
}

export function crewmateFoldWords(name: string, running: boolean): string {
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

export const CREWMATE_BETWEEN_TURNS_DETAIL = `it is between turns and nothing drains a queued line — r in ${CREW_VIEW_DOOR} resumes it from its transcript`

export function crewmateInterruptRefusedWords(name: string, detail: string): string {
  return `${name} did not take the interrupt: ${detail}`
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
  return `${name} interrupted — ${LEAD_ROW_NAME} is told; a queued message lands as it stops`
}
