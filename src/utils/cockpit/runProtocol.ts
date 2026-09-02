// ============================================================================
//  runProtocol — the minimal Mercury run-protocol prompt section (Sol 5.6
//  frontier sprint.5).
//
//  ONE compact, cache-stable section teaching the main implementation agent
//  how the durable-run substrate behaves — composed ONCE here (never
//  duplicated across prompt fragments; role packs add only deltas). It does
//  NOT change the identity opener; it rides the dynamic-section registry
//  after the harness map.
//
//  SESSION-TRUTH LAW (same contract as harnessMap.ts): a line renders only
//  when its surface is real in THIS session — the IDE-loop lines require the
//  LSP/Debug tools in the mounted roster, and the slash-surface line requires
//  an interactive cockpit (a headless `-p` run has no operator to type /run).
//  Memoized per roster shape: byte-stable across turns (prompt-cache law).
// ============================================================================

import { isSessionMarkedNonInteractive } from './runtimePosture.js'

export interface RunProtocolRoster {
  /** The LSP tool is in this session's mounted tool roster. */
  lspMounted: boolean
  /** The Debug (DAP) tool is in this session's mounted tool roster. */
  dapMounted: boolean
}

const memo = new Map<string, string>()

export function getRunProtocolSection(roster: RunProtocolRoster): string | null {
  const interactive = !isSessionMarkedNonInteractive()
  const key = `${roster.lspMounted ? 1 : 0}${roster.dapMounted ? 1 : 0}${interactive ? 1 : 0}`
  const cached = memo.get(key)
  if (cached !== undefined) return cached

  const bullets = [
    "- For multi-deliverable work, create/update task items as you go; they ARE the run's deliverable list. Act on the next unblocked item instead of narrating future action.",
    '- Tool effects and verification evidence are ground truth. A returned string that reports a failure is a failure; a mutation counts only when it actually landed. After code changes, run the smallest real verification that covers the changed behavior — a run cannot complete with a post-mutation evidence gap.',
    '- Finish every requested in-scope deliverable before declaring completion. If only the operator can resolve something, declare ONE precise blocker by ending your message with the two lines "BLOCKED ON OPERATOR: <what you need>" then "RESUME WHEN: <what unblocks you>" — that records it, stops the loop cleanly, and the operator\'s answer resumes the run. Never loop on a blocker in prose.',
    '- On resume, a reconciled run capsule tells you what is already done, what was interrupted mid-flight, and the next concrete action. Inspect an interrupted operation\'s real state before retrying; never repeat completed work.',
    ...(interactive
      ? ['- `/run` shows the live run; `/context` shows the exact request projection.']
      : []),
  ]

  // The IDE-loop lines, gated line by line on the MOUNTED roster.
  const ideSentences: string[] = []
  if (roster.lspMounted) {
    ideSentences.push(
      'prefer LSP for symbol discovery, references, structured rename, and offered code actions; use direct file edits for small local changes where that is clearer. After a code mutation, get current diagnostics when a language server covers the file, then run the smallest real proof that covers the changed behavior.',
    )
  }
  if (roster.dapMounted) {
    ideSentences.push(
      'Use the Debug tool (DAP) when a runtime-state question cannot be resolved from static evidence.',
    )
  }
  const evidenceLine =
    'Current evidence is what completes a run, not a prescribed number of tool calls.'
  const idePara =
    ideSentences.length > 0
      ? `IDE loop: ${ideSentences.join(' ')} An LSP/Debug operation that reports failed or indeterminate is exactly that — never treat an unavailable IDE lane as success; fall back honestly and keep the run state current. ${evidenceLine}`
      : evidenceLine

  const section = `# Autonomous runs

A substantive coding request becomes a durable run: Mercury tracks the objective, deliverables, tool effects, verification evidence, and context epoch, and the stop decision is made from that state — not from how your last sentence reads. Work with it:

${bullets.join('\n')}

${idePara}`
  memo.set(key, section)
  return section
}

/** TEST-ONLY: drop the memo. */
export function _resetRunProtocolForTesting(): void {
  memo.clear()
}
