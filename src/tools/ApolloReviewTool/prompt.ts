
export { APOLLO_REVIEW_TOOL_NAME } from './constants.js'

export const APOLLO_REVIEW_TOOL_PROMPT = `Presents the closing review card of a completed Apollo pre-flight spec to the user — the plain-language summary, the blockers, the spec files and where the prototype will run — and returns the answer they chose. With no blockers the card offers three answers: a plain yes moves the session out of Apollo Mode into the build posture (the autonomous mode when available, otherwise edit-approved) and starts the build at once; yes-but-ask-first starts it with each edit asking for confirmation; a hold keeps the session and the spec drafts in Apollo Mode. With blockers present nothing changes hands.`
