import { JEV_TOOL_NAME } from '../../services/jev/jevContract.js'

export const JEV_EVAL_TOOL_NAME = JEV_TOOL_NAME
export const JEV_EVAL_ESCAPE_OPTION = 'none'
export const JEV_EVAL_ESCAPE_MEANS = 'None of the listed options fits'
export const JEV_EVAL_MAX_RESULT_CHARS = 20_000
export const JEV_EVAL_MAX_GOAL_CHARS = 200
export const JEV_EVAL_MAX_ID_CHARS = 64
export const JEV_EVAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/
export const JEV_EVAL_LEVEL_LABEL_CLIP = 40
export const JEV_EVAL_CONFIDENCE_FLOOR = 0.6
export const JEV_EVAL_UNSURE = 'unsure'
export const JEV_EVAL_PARAGRAPH_FACT = 'text'
export const JEV_EVAL_ROW_POSITION_PREFIX = '#'
export const JEV_EVAL_BYTES_PER_TOKEN = 4
export const JEV_EVAL_TOKENIZER_NOTE = 'bytes/4 — the provider publishes no tokenizer'
export const JEV_EVAL_FORBIDDEN_FIELDS: readonly string[] = ['approve', 'allow', 'verdict', 'safe', 'gate', 'advice', 'explain']
export const JEV_EVAL_FILE_KEY = 'file'
export const JEV_EVAL_TABLE_KEY = 'table'
export const JEV_EVAL_ID_COLUMN = 'id'
export const JEV_EVAL_MAX_ROWS = 100
export const JEV_EVAL_MAX_FILE_BYTES = 1_048_576
export const JEV_EVAL_FORMATS = ['tsv', 'csv', 'markdown', 'jsonl', 'text', 'paragraphs'] as const
export const JEV_EVAL_FORMAT_BY_EXTENSION: Readonly<Record<string, (typeof JEV_EVAL_FORMATS)[number]>> = { '.tsv': 'tsv', '.csv': 'csv', '.md': 'markdown', '.markdown': 'markdown', '.jsonl': 'jsonl', '.ndjson': 'jsonl' }
