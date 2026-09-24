import { JEV_STATUS_KINDS, JEV_SUBAGENT_CALL_BUDGET, type JevStatusKind } from '../../services/jev/jevContract.js'
import { JEV_STATUS_HEADWORDS, jevStatusIsFinalForSession } from '../../services/jev/jevStatus.js'

export const JEV_EVAL_SEARCH_HINT = 'Jev second opinion: rank hypotheses, judge calls, check proposals'

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

export const JEV_EVAL_PROMPT = `One paid round trip to TypeSafe's Jev for a second opinion on a judgement you have already framed. This is not the Eval tool: Eval runs code cells, JevEval runs no code and returns numbers. Jev is not a chat model — it writes no prose, code or explanations. It reads the \`evidence\` you supply and answers typed questions: \`noul\` (the probability, 0..1, that a yes/no statement holds), \`choice\` (one of your options, with a probability per option and a confidence), \`score\` (a probability-weighted position on your ordered levels, with a confidence). Treat every number as an opinion, not evidence: 0 and 1 prove nothing; a confidence measures how concentrated the distribution is, not how often Jev is right; a noul carries no confidence at all; Jev gives no reasons, so never attribute a rationale to it.

Its first uses are three: (1) rank hypotheses once the evidence is in, including which test would separate them; (2) a qualitative call after the frames or numbers are measured — code measures, Jev judges; (3) check a proposal against the owner's recorded rulings, quoted into \`evidence\`. Call it when a real fork is in front of you, you hold the evidence to frame it, and the answer could change your next action. Put every option you are genuinely weighing into \`options\` — an option you omit cannot be chosen — and set \`allow_none\` so Jev can say none of them fit. Send only the evidence the question turns on: filtered excerpts, never whole files, never the transcript, never environment values, secrets or stack traces — everything sent leaves the machine and is retained by the provider, and unrelated material measurably costs accuracy. Ask everything you want to know in ONE call: the questions are evaluated in parallel against the same evidence, and a second call re-sends it. A sub-agent has ${JEV_SUBAGENT_CALL_BUDGET} calls for its whole task; use them only if needed.

Do not call it as a ritual before every test, or for anything code settles exactly — arithmetic, geometry, resizing, dates, counts, measured frames: compute them, and pass the computed value in if you ask at all. Do not call it for facts already in your context, before the evidence is gathered, or in place of your own reasoning. Never call it to grant a permission or to satisfy a consent gate, and never as proof that tests pass, a build is green or a gate is met — only the actual check establishes that. Do not re-ask a rephrased question because you disliked the answer: report the answer that came back even when it contradicts you, and settle a disagreement by reading the code.

${JEV_EVAL_UNAVAILABILITY}`
