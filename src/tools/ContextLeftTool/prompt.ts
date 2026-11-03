export const CONTEXT_LEFT_SEARCH_HINT = 'how much context window is left: tokens used, window, tokens before autocompact'

export const CONTEXT_LEFT_DESCRIPTION =
  'Reports how full your context window is: tokens used, the window, the percent, and the tokens left before autocompact folds the transcript.'

export const CONTEXT_LEFT_PROMPT = `Reports how full the context window is — the tokens used, the window, the percent, and the tokens left until autocompact folds the transcript — from the same derivation the operator's context gauge reads, each number labelled measured on the wire or estimated from characters. Until this session's first answer the count is unknown, and the answer says so while still naming the window; a window marked ~ is a conservative default, not a figure the provider stated.`
