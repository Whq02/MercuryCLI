// intent before destination.
//
// The ONE classifier for what a submission from the composer means while an
// agent transcript is the viewed target. PromptInput.onSubmit consumes it for
// routing; the intent-routing prover generates the registry×context matrix from this
// same function, so advertised behaviour and executed behaviour cannot drift.
//
// Laws:
//   · a registered, enabled, session-scoped command executes in THIS session
//     exactly as from the main view — never as agent conversation text;
//   · a keybinding-manufactured command is classified like typed input (the
//     origin changes immediacy, never the destination);
//   · unknown slash input is never silently delivered to the agent — the
//     caller reports it honestly and preserves the draft;
//   · '//x …' is the explicit literal-send path: '/x …' as agent text;
//   · everything else is agent guidance.

import { type Command, findCommand, isCommandEnabled } from '../../commands.js'

export type AgentViewIntent =
  /** Deliver `text` to the viewed agent as conversation text (explicit '//'). */
  | { kind: 'agent-literal'; text: string }
  /** Execute in this session via the normal leader submit path. */
  | { kind: 'session-command'; command: Command }
  /** A registered command the registry scopes to the agent channel. */
  | { kind: 'agent-command'; command: Command }
  /** Slash-shaped input matching no enabled command: report, keep the draft. */
  | { kind: 'unknown-command'; bareName: string }
  /** Plain guidance for the viewed agent. */
  | { kind: 'agent-guidance' }

export function classifyAgentViewSubmission(
  inputParam: string,
  fromKeybinding: boolean,
  commands: Command[],
): AgentViewIntent {
  const trimmed = inputParam.trim()
  if (trimmed.startsWith('//')) {
    return { kind: 'agent-literal', text: trimmed.slice(1) }
  }
  if (fromKeybinding || trimmed.startsWith('/')) {
    const spaceIdx = trimmed.indexOf(' ')
    const bareName = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).replace(/^\//, '')
    const matching = findCommand(bareName, commands)
    if (matching && isCommandEnabled(matching)) {
      return (matching.scope ?? 'session') === 'session'
        ? { kind: 'session-command', command: matching }
        : { kind: 'agent-command', command: matching }
    }
    return { kind: 'unknown-command', bareName }
  }
  return { kind: 'agent-guidance' }
}
