import { JEV_EVAL_CONFIDENCE_FLOOR } from './constants.js'

export const JEV_EVAL_SEARCH_HINT = 'Jev second opinion: rank hypotheses, judge calls, check proposals'

const NOUL_UNSURE_LOW = Number((1 - JEV_EVAL_CONFIDENCE_FLOOR).toFixed(2))

export const JEV_EVAL_DESCRIPTION =
  "A second opinion from TypeSafe's Jev: typed yes/no, choice and score questions over evidence you supply, answered with numbers only — never an approval, never a reason"

export const JEV_EVAL_PROMPT = `Paid second opinion from TypeSafe's Jev over \`evidence\` you supply, answered with numbers only (no prose or reasons): \`noul\` returns p(yes) in 0..1; \`choice\` returns per-option probabilities + confidence; \`score\` returns a level position + confidence. Numbers are opinions, not proof (confidence reflects distribution concentration, not accuracy). Use when a closed question over evidence decides your next step.

Returns a table (row per item, column per question, unanswered rows marked) with floor ${JEV_EVAL_CONFIDENCE_FLOOR}: choice/score confidence < ${JEV_EVAL_CONFIDENCE_FLOOR} or noul p(yes) in ${NOUL_UNSURE_LOW}..${JEV_EVAL_CONFIDENCE_FLOOR} reads unsure alongside its numbers.`
