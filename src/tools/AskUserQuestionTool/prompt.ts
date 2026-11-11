
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

export const DISCUSS_OPTION_LABEL = 'Chat about this'

export const DESCRIPTION =
  'Put a fixed set of choices in front of the user — to collect facts, resolve something ambiguous, learn a preference, settle a decision, or present alternatives.'

export const PREVIEW_FEATURE_PROMPT: Record<'markdown' | 'html', string> = {
  markdown: `Previews use multiline Markdown in a monospace box beside a vertical option list. Single-select only.`,
  html: `Previews use a self-contained HTML fragment with inline styles, without a document wrapper, script or style elements. Single-select only.`,
}

export const ASK_USER_QUESTION_TOOL_PROMPT = `Ask structured multiple-choice questions and return the user's answers.`
