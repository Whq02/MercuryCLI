export const DESCRIPTION = 'Deliver a message to a running crewmate of this session by its id or name.'

export function getPrompt(): string {
  return `Delivers a message to a running crewmate of this session; it never starts work, and a crewmate that has finished is refused. Plain output reaches no crewmate: words travel only as messages. A running crewmate reads the message at its next tool boundary, else at the end of its turn; the main agent reads it the same way, and between turns it starts a turn for it. A message relayed to you is already rendered to the user.`
}
