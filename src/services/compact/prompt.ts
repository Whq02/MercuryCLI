/**
 * The summariser instruction texts and the post-compact summary wrapper.
 * All prompt text is Mercury-authored; the content requirements (the nine
 * sections, the no-tools framing, the analysis block) are the contract.
 */

/**
 * Every summariser prompt opens with this. The fork gets a single turn, so
 * a refused tool call means the turn produces no text and the whole attempt
 * falls through to the slower fallback path — stated plainly, first.
 * (Measured attempted-tool-call rate on a newer model generation: ~2.8%,
 * against ~0.01% the generation before.)
 */
const NO_TOOLS_PREAMBLE = `Reply with prose only — no tool calls of any kind. Do not invoke Read, Bash, Grep, Glob, Edit, Write, Task, or any other tool. Any tool call will be refused outright, and because you have exactly one turn, a refused call means this summarisation attempt produces nothing and fails. The conversation below already contains everything you need; there is nothing to look up.`

const NO_TOOLS_TRAILER = `Remember: prose only, no tool calls. Produce the analysis and summary now.`

function analysisInstruction(scope: 'conversation' | 'recent'): string {
  const subject = scope === 'conversation' ? 'the conversation' : 'the recent messages'
  return `Before writing the summary, wrap your thinking in an <analysis> block. Inside it, walk ${subject} chronologically and identify, for each section:
- The operator's explicit requests and intents.
- The approach taken.
- Key decisions, technical concepts and code patterns.
- Specific details: file names, full code snippets, function signatures, file edits.
- Errors that were hit and how they were fixed — paying particular attention to operator feedback, especially corrections.
Then double-check your analysis for technical accuracy and completeness.`
}

const NINE_SECTIONS = `Your summary must contain these nine numbered sections:
1. Operator Intent: every explicit request, in detail.
2. Technical Ground: technologies, patterns and frameworks in play.
3. Files and Code Touched: files examined, modified or created — with particular attention to the most recent messages, full code snippets where applicable, and a note on why each file matters.
4. Errors and Corrections: every error hit, how it was fixed, and any operator feedback about it.
5. Problems Worked: problems solved and any ongoing troubleshooting.
6. Operator Messages: every message the operator sent that is not a tool result.
7. Open Work: work the operator explicitly asked for that is not yet done.
8. Where Work Stands: precisely what was being worked on most recently, with file names and code snippets.
9. Next Move (optional): the next step directly in line with the operator's most recent explicit request and the task in flight. Do not start tangential or already-completed work without confirming first. Include verbatim quotes from the most recent conversation showing exactly what task was in hand and where it stopped.`

const OUTPUT_EXAMPLE = `Structure your output like this:
<analysis>
[Your chronological walk and verification]
</analysis>
<summary>
1. Operator Intent:
   [...]
2. Technical Ground:
   [...]
3. Files and Code Touched:
   [...]
4. Errors and Corrections:
   [...]
5. Problems Worked:
   [...]
6. Operator Messages:
   [...]
7. Open Work:
   [...]
8. Where Work Stands:
   [...]
9. Next Move (optional):
   [...]
</summary>`

const EXTRA_INSTRUCTIONS_NOTE = `The included context may contain additional summarisation instructions — for example a CLAUDE.md section saying "when compacting, always preserve the full list of failing tests", or an operator note reading "focus the summary on the database migration work". Follow any such instructions when producing the summary.`

const BASE_TEMPLATE = `Write the running record of this conversation: a summary detailed enough that development continues without losing context. Weigh the operator's explicit requests and your own prior actions heavily, and keep the technical grain — code patterns, architectural decisions, exact detail.

${NINE_SECTIONS}

${OUTPUT_EXAMPLE}

${EXTRA_INSTRUCTIONS_NOTE}`

/**
 * Appended only when a deterministic run-continuation capsule will be
 * installed alongside the summary: redirect the model's budget away from
 * inventories the capsule already holds.
 */
const RUN_CAPSULE_STEERING = `A machine-generated continuation record accompanies your summary. It already holds the factual inventories — what the run is for, the state of each deliverable, which files changed, which attempts failed, where verification stands, and what happens next — so repeating them is wasted effort. Spend your budget on what only you can supply: constraints and decisions the operator has imposed that are still binding, the reasoning that ruled out the approaches already discarded, the non-obvious context behind the approach now in flight, and pointers to the files and symbols the next turn should simply re-read. Keep verbatim fragments only where they carry weight and cannot be recovered from the repository.`

function withCustomInstructions(body: string, customInstructions: string | undefined): string {
  const trimmed = customInstructions?.trim()
  if (trimmed === undefined || trimmed === '') return body
  return `${body}\n\n## Additional instructions\n${trimmed}`
}

export function getCompactPrompt(
  customInstructions?: string,
  opts?: { runCapsulePresent?: boolean },
): string {
  const parts = [NO_TOOLS_PREAMBLE, analysisInstruction('conversation'), BASE_TEMPLATE]
  if (opts?.runCapsulePresent === true) parts.push(RUN_CAPSULE_STEERING)
  return `${withCustomInstructions(parts.join('\n\n'), customInstructions)}\n\n${NO_TOOLS_TRAILER}`
}

const FROM_TEMPLATE = `Summarise ONLY the recent portion of this conversation — the messages after the retained earlier context. The earlier messages are being kept intact and need no summary.

${NINE_SECTIONS.replace('the conversation', 'the recent messages')}

${OUTPUT_EXAMPLE}

${EXTRA_INSTRUCTIONS_NOTE}`

const UP_TO_TEMPLATE = `Summarise this conversation. Your summary will be placed at the START of a continuing session, with newer messages following it that you cannot see — so it must be thorough enough that someone reading only your summary plus those newer messages can continue the work.

Your summary must contain these nine numbered sections:
1. Operator Intent: every explicit request, in detail.
2. Technical Ground: technologies, patterns and frameworks in play.
3. Files and Code Touched: files examined, modified or created — with full code snippets where applicable and a note on why each file matters.
4. Errors and Corrections: every error hit, how it was fixed, and any operator feedback about it.
5. Problems Worked: problems solved and any ongoing troubleshooting.
6. Operator Messages: every message the operator sent that is not a tool result.
7. Open Work: work the operator explicitly asked for that is not yet done.
8. Delivered This Stretch: what was finished by the end of this portion of the conversation.
9. Context to Carry: the context, decisions and state needed to understand and continue the work in the subsequent messages.

${OUTPUT_EXAMPLE}

${EXTRA_INSTRUCTIONS_NOTE}`

export function getPartialCompactPrompt(
  customInstructions?: string,
  direction: 'from' | 'up_to' = 'from',
): string {
  const parts = [
    NO_TOOLS_PREAMBLE,
    // The conversation-scoped analysis serves the base prompt AND `up_to`;
    // only `from` uses the recent-scoped variant.
    analysisInstruction(direction === 'from' ? 'recent' : 'conversation'),
    direction === 'from' ? FROM_TEMPLATE : UP_TO_TEMPLATE,
  ]
  return `${withCustomInstructions(parts.join('\n\n'), customInstructions)}\n\n${NO_TOOLS_TRAILER}`
}

/**
 * Remove the first <analysis> block entirely (a drafting scratchpad);
 * replace a <summary> block with a plain `Summary:` heading plus its
 * trimmed content; collapse blank-line runs; trim. The two tag names are
 * contract data — the model is instructed to emit them.
 */
export function formatCompactSummary(summary: string): string {
  let out = summary.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
  const summaryBlock = /<summary>([\s\S]*?)<\/summary>/.exec(out)
  if (summaryBlock !== null) {
    out = out.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${(summaryBlock[1] as string).trim()}`)
  }
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/** The user-message text that carries the formatted summary post-compact. */
export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string {
  const parts = [
    'The context window turned over; this session carries on from an earlier stretch of the same conversation. The summary below holds the earlier portion.',
    formatCompactSummary(summary),
  ]
  if (transcriptPath !== undefined && transcriptPath !== '') {
    parts.push(
      `When a precise artifact from before the turnover matters — an exact snippet, an error text, something you wrote — the complete transcript is on disk at: ${transcriptPath}`,
    )
  }
  if (recentMessagesPreserved === true) {
    parts.push('The most recent messages of the conversation are preserved verbatim after this summary.')
  }
  if (suppressFollowUpQuestions === true) {
    parts.push(
      'Pick the work up exactly where it stopped, with no questions back to the operator. Resume directly — no acknowledgement of the summary, no recap of what was happening, no "I\'ll continue" preface. Carry the last task on as if the break never happened.',
    )
  }
  return parts.join('\n\n')
}
