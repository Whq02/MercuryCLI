import { JEV_STATUS_KINDS, JEV_SUBAGENT_CALL_BUDGET, JEV_SUBAGENT_PACE_PER_MINUTE, type JevStatusKind } from '../../services/jev/jevContract.js'
import { JEV_STATUS_HEADWORDS, jevStatusIsFinalForSession } from '../../services/jev/jevStatus.js'
import { JEV_EVAL_CONFIDENCE_FLOOR, JEV_EVAL_PARAGRAPH_FACT, JEV_EVAL_ROW_POSITION_PREFIX } from './constants.js'

export const JEV_EVAL_SEARCH_HINT = 'Jev second opinion: rank hypotheses, judge calls, check proposals'

const NOUL_UNSURE_LOW = Number((1 - JEV_EVAL_CONFIDENCE_FLOOR).toFixed(2))

export const JEV_EVAL_EXAMPLE = JSON.stringify({
  goal: 'which of two reds was killed from outside',
  evidence: [
    { id: 'ui', tail: 'rc 137 after the 240 s deadline; the last frame is blank' },
    { id: 'api', tail: "expected the row 'settled', the frame reads 'settling'; rc 1" },
  ],
  questions: [
    { id: 'killed', kind: 'noul', ask: 'Does `tail` name a kill from outside (rc 137, a signal, a deadline kill)?' },
    {
      id: 'class',
      kind: 'choice',
      ask: 'Which class does `tail` show?',
      options: { harness: 'a kill or a runner fault', product: 'the product answers with other words' },
      allow_none: true,
      none_means: 'the words decide neither',
    },
  ],
})

export const JEV_EVAL_DESCRIPTION =
  "A second opinion from TypeSafe's Jev: typed yes/no, choice and score questions over evidence you supply, answered with numbers only — never an approval, never a reason"

const REASONS: readonly JevStatusKind[] = JEV_STATUS_KINDS.filter(kind => kind !== 'ready')
const FINAL_REASONS = REASONS.filter(kind => jevStatusIsFinalForSession(kind))
const WAIT_REASONS = REASONS.filter(kind => !jevStatusIsFinalForSession(kind))

function list(kinds: readonly JevStatusKind[]): string {
  return kinds.map(kind => JEV_STATUS_HEADWORDS[kind]).join(', ')
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export const JEV_EVAL_UNAVAILABILITY = `An unavailable result is one line naming the reason with its evidence — ${list(REASONS)}. ${sentence(list(FINAL_REASONS))} end Jev for this session: note it once and carry on unaided. ${sentence(list(WAIT_REASONS))} name when the next attempt is admitted; do not call before then. Never retry a refusal.`

export const JEV_EVAL_PROMPT = `One paid round trip to TypeSafe's Jev for a second opinion on a judgement you have already framed. This is not the Eval tool: Eval runs code cells, JevEval runs no code and returns numbers. Jev is not a chat model — it writes no prose, code or explanations. It reads the \`evidence\` you supply and answers typed questions: \`noul\` (the probability, 0..1, that a yes/no statement holds), \`choice\` (one of your options, with a probability per option and a confidence), \`score\` (a probability-weighted position on your ordered levels, with a confidence). Treat every number as an opinion, not evidence: 0 and 1 prove nothing; a confidence measures how concentrated the distribution is, not how often Jev is right; a noul carries no confidence at all; Jev gives no reasons, so never attribute a rationale to it. The floor is ${JEV_EVAL_CONFIDENCE_FLOOR}: under the floor the cell reads unsure — do not act on it — a choice or a score whose confidence is under ${JEV_EVAL_CONFIDENCE_FLOOR}, and a noul carries no confidence, so its p(yes) from ${NOUL_UNSURE_LOW} through ${JEV_EVAL_CONFIDENCE_FLOOR} reads unsure (the floor mirrored around a half); the numbers stay in the cell and the header names the floor once.

Use it whenever a closed question over evidence in front of you decides the next step: which hypothesis the measured numbers favour and which test would separate them; a qualitative call once the frames or numbers are measured — code measures, Jev judges; a proposal against the owner's recorded rulings, quoted into \`evidence\`. Ask only what the evidence answers — a question the words in \`evidence\` settle, never one that needs the tree. Shapes that answered from the words: was this run killed from outside? (\`tail\` reads "rc 137, killed mid-proof"); did the capture starve? (\`output\` reads "capture deadline exceeded; the last frame is empty"); does the output name a fixture fault? (\`output\` reads "the proof's own stand-in refused the socket" — the weakest of the three); does this line need the lead's answer? (\`line\` opens "QUESTION FOR THE LEAD"); should this command be asked first? (\`command\` reads "git push --force origin working"). Shapes that did not: is the product wrong or is the proof stale? (\`output\` reads "expected the row 'settled', the frame reads 'settling'" — a coin flip, confidently wrong either way) and did the fold's intent change this? (\`fold_intent\` lists the commit subjects since the base — never above a coin flip). For those two, run the proof on the tip and read the source; never ask Jev. What code settles exactly — arithmetic, geometry, resizing, dates, counts, measured frames — and what is already in your context is evidence to pass in, not a question to ask. Put every option you are genuinely weighing into \`options\` — an option you omit cannot be chosen — and set \`allow_none\` so Jev can say none of them fit. Send only the evidence the question turns on: filtered excerpts, never whole files, never the transcript, never environment values, secrets or stack traces — everything sent leaves the machine under the selected road's data policy, and unrelated material measurably costs accuracy. \`evidence\` is a list of evidence items — each a record of named facts (an optional \`id\` labels its row) or a bare paragraph (sent as the one fact \`${JEV_EVAL_PARAGRAPH_FACT}\`) — and \`questions\` is one question set: every item is judged against every question, one request per item, all in flight at once, each counted against the pace and the budget; one table comes back, rows keyed by the item's id or position (${JEV_EVAL_ROW_POSITION_PREFIX}1, ${JEV_EVAL_ROW_POSITION_PREFIX}2, …), columns the question ids, a row that no answer reached saying so in place. To repeat the same questions over a list of paragraphs, pass the paragraphs: \`"evidence": ["first paragraph …", "second paragraph …"]\` comes back as rows ${JEV_EVAL_ROW_POSITION_PREFIX}1 and ${JEV_EVAL_ROW_POSITION_PREFIX}2. Ask everything you want to know in ONE call: a second call re-sends the evidence. A sub-agent has ${JEV_SUBAGENT_CALL_BUDGET} calls for its whole task; all sub-agents in a session share ${JEV_SUBAGENT_PACE_PER_MINUTE} requests a minute on each road, separately from the main model's pace.

One complete call, as sent:
${JEV_EVAL_EXAMPLE}
reads back as rows ui and api under the columns killed (noul) and class (choice).

Never call it to grant a permission or to satisfy a consent gate, and never as proof that tests pass, a build is green or a gate is met — only the actual check establishes that. Do not re-ask a rephrased question because you disliked the answer: report the answer that came back even when it contradicts you, and settle a disagreement by reading the code.

${JEV_EVAL_UNAVAILABILITY}`
