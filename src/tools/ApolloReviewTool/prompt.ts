// ApolloReview name and tool doctrine — the Apollo interview's closing seam
//

export { APOLLO_REVIEW_TOOL_NAME } from './constants.js'

export const APOLLO_REVIEW_TOOL_PROMPT = `Present the closing review of a completed Apollo pre-flight spec.

Call this ONLY in Apollo Mode, once the interview is finished and the spec files are written. It renders the closing review card for the user: your plain-language summary of the completed spec, the blocker state, the spec files, and where the prototype will run.

- \`summary\`: the layman review of the completed spec — concise plain language; a technical term only as a bridge beside its plain meaning.
- \`blockers\`: what still prevents a one-shot prototype, each with your short comment. Pass an EMPTY list when nothing blocks — an empty list asks the user to begin the build.
- \`specFiles\`: the spec files the interview produced, absolute paths.
- \`runNote\`: where and how the finished prototype will be run, in one plain line.

A clean review offers the user three answers. Either yes moves the session out of Apollo Mode and starts the build immediately — plain yes lands the build posture (the safer autonomous mode when available, otherwise edit-approved mode); yes-but-ask-first runs the build with each edit asking for confirmation. The third answer holds the review: the session and drafts stay, and you resume the interview — poll again, settle what is open, then present the review afresh. The tool result states which outcome the user chose; follow it.

With blockers present nothing changes hands: the card presents them; resolve them with the user, then call this again. Never list a blocker you could resolve yourself by reading the project, and never pass an empty blocker list while anything material is still unsettled. Never begin project edits from the interview — this review is the only door to the build.`
