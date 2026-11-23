export const DESCRIPTION = 'Give a crewmate of this session a new turn by its id or name, resuming it from its transcript if it has finished; interrupt: true cuts a running turn to start the new one.'

export function getPrompt(): string {
  return `Gives a crewmate of this session its next turn: the message. A crewmate that has finished (completed, failed or stopped) is resumed from its transcript in the background with its full context; a running one reads the message at its next tool boundary, or, with interrupt: true, its turn is cut after its partial transcript is saved and the new turn starts. A resumed turn is a paid turn of that crewmate; its completion notice reaches the main agent, and a crewmate launched with an output schema keeps its StructuredOutput tool for the resumed turn.`
}
