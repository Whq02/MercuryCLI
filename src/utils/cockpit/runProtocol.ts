import { isSessionMarkedNonInteractive } from './runtimePosture.js'

export interface RunProtocolRoster {
  taskToolsMounted?: boolean
}

const memo = new Map<string, string>()

export function getRunProtocolSection(roster: RunProtocolRoster): string | null {
  const interactive = !isSessionMarkedNonInteractive()
  const key = `${interactive ? 1 : 0}${roster.taskToolsMounted ? 1 : 0}`
  const cached = memo.get(key)
  if (cached !== undefined) return cached

  const bullets = [
    ...(roster.taskToolsMounted ? ['- For multi-deliverable work, create and update task items as you go; they are the run\'s deliverable list. Act on the next unblocked item instead of narrating future action.'] : []),
    '- Tool effects and verification evidence are ground truth. A returned string that reports a failure is a failure; a mutation counts only when it actually landed. After code changes, run the smallest real verification that covers the changed behavior — a run cannot complete with a post-mutation evidence gap.',
    '- If only the operator can resolve something, declare one precise blocker by ending your message with the two lines "BLOCKED ON OPERATOR: <what you need>" then "RESUME WHEN: <what unblocks you>" — that records it, stops the loop cleanly, and the operator\'s answer resumes the run. Never loop on a blocker in prose.',
    '- On resume, a reconciled run capsule tells you what is already done, what was interrupted mid-flight, and the next concrete action. Inspect an interrupted operation\'s real state before retrying; never repeat completed work.',
    ...(interactive
      ? ['- `/run` shows the live run; `/context` shows the exact request projection.']
      : []),
  ]

  const section = `# Autonomous runs

A substantive coding request becomes a durable run: Mercury tracks the objective, deliverables, tool effects, verification evidence, and context epoch, and the stop decision is made from that state — not from how your last sentence reads.

${bullets.join('\n')}`
  memo.set(key, section)
  return section
}
