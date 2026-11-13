export const CONTEXT_LEFT_SEARCH_HINT = 'how much context window is left: tokens used, window, tokens before autocompact'

export const CONTEXT_LEFT_DESCRIPTION =
  'Reports how full your context window is: tokens used, the window, the percent, and the tokens left before autocompact folds the transcript.'

export const CONTEXT_LEFT_PROMPT = `Reports context-window usage (tokens used, window, percent, and tokens left until autocompact) from the operator's context gauge, marking each figure wire-measured or char-estimated. Before the first answer the count is unknown (window still shown); a ~ window is a conservative default, not provider-stated.`
