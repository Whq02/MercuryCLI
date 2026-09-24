import { JEV_TOOL_NAME } from '../../services/jev/jevContract.js'

export const JEV_EVAL_TOOL_NAME = JEV_TOOL_NAME
export const JEV_EVAL_ESCAPE_OPTION = 'none'
export const JEV_EVAL_ESCAPE_MEANS = 'None of the listed options fits'
export const JEV_EVAL_MAX_RESULT_CHARS = 20_000
export const JEV_EVAL_MAX_GOAL_CHARS = 200
export const JEV_EVAL_MAX_ID_CHARS = 64
export const JEV_EVAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/
export const JEV_EVAL_FULL_DISTRIBUTION_LIMIT = 6
export const JEV_EVAL_TIE_MARGIN = 0.05
export const JEV_EVAL_LEVEL_LABEL_CLIP = 40
export const JEV_EVAL_BYTES_PER_TOKEN = 4
export const JEV_EVAL_TOKENIZER_NOTE = 'bytes/4 — the provider publishes no tokenizer'
export const JEV_EVAL_FORBIDDEN_FIELDS: readonly string[] = ['approve', 'allow', 'verdict', 'safe', 'gate', 'advice', 'explain']
