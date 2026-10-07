export const DESCRIPTION = 'Give a crewmate of this session a new turn by its id or name, resuming it from its transcript if it has finished.'

export function getPrompt(): string {
  return `Give a crewmate of this session more work: your message becomes its next turn. A crewmate that has finished (completed, failed or stopped) is resumed from its transcript in the background, with its full context. A running crewmate is never started twice: it reads the message at its next tool boundary.

Example: { "to": "researcher", "message": "Now map the token refresh path the same way." }

## Addressing
- to: the id a crewmate's launch receipt names, or the name its launch gave it — both reach the same agent, running or finished (a name two launches carried reaches the newest).

## Which verb
- ResumeAgent when the crewmate must act on the message, running or not; a resumed turn is a paid turn of that agent. SendMessage only for a note to a running crewmate. Agent starts a new crewmate with no context.
- A resumed crewmate's completion notice reaches the main agent. One launched with output_schema keeps its StructuredOutput tool for the resumed turn.`
}
