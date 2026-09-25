export const CONTEXT_LEFT_SEARCH_HINT = 'how much context window is left: tokens used, window, tokens before autocompact'

export const CONTEXT_LEFT_DESCRIPTION =
  'Reports how full your context window is: tokens used, the window, the percent, and the tokens left before autocompact folds the transcript.'

export const CONTEXT_LEFT_PROMPT = `Report how full your context window is: the tokens used and the window, the percent, and the tokens left until autocompact folds the transcript. Every number comes from the same derivation the operator's context gauge reads, and each is labelled as measured on the wire or estimated from characters. Takes no parameters.

Use it when:
- you are about to read something large (a whole file, a long log, many search results) and want to know whether it fits;
- you are planning a large edit or a long multi-step job and need to budget the rest of the work;
- the operator asks how much context you have left.

Do not call it every turn: the answer changes only as the transcript grows. Until you have answered once in a session the count is unknown; the answer says so and still names the window, and a second call made right after it is measured. A window marked ~ is a conservative default, not a figure the provider stated.`
