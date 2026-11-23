import { JEV_EVAL_CONFIDENCE_FLOOR } from './constants.js'

export const JEV_EVAL_SEARCH_HINT = 'Jev second opinion: rank hypotheses, judge calls, check proposals'

const NOUL_UNSURE_LOW = Number((1 - JEV_EVAL_CONFIDENCE_FLOOR).toFixed(2))

export const JEV_EVAL_DESCRIPTION =
  "A second opinion from TypeSafe's Jev: typed yes/no, choice and score questions over evidence you supply, answered with numbers only — never an approval, never a reason"

export const JEV_EVAL_PROMPT = `One paid round trip to TypeSafe's Jev for a second opinion on a judgement you have framed. Jev reads only the \`evidence\` you supply and answers each typed question with numbers: \`noul\` the probability, 0..1, that a yes/no statement holds; \`choice\` one of your options, with a probability per option and a confidence; \`score\` a position on your ordered levels, with a confidence. It writes no prose and gives no reasons, and a number is an opinion, not evidence: 0 and 1 prove nothing, and a confidence measures how concentrated the distribution is, not how often Jev is right. Use it whenever a closed question over evidence in front of you decides the next step.

One table comes back: a row per evidence item, keyed by its id or by position, a column per question, and a row that no answer reached says so in place. The header names the floor, ${JEV_EVAL_CONFIDENCE_FLOOR}: a choice or score whose confidence is under it, or a noul whose p(yes) lies from ${NOUL_UNSURE_LOW} through ${JEV_EVAL_CONFIDENCE_FLOOR} (the floor mirrored around a half, since a noul carries no confidence), reads unsure with its numbers kept.`
