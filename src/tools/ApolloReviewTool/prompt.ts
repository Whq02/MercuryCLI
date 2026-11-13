
export { APOLLO_REVIEW_TOOL_NAME } from './constants.js'

export const APOLLO_REVIEW_TOOL_PROMPT = `Presents the closing review card of a completed Apollo pre-flight spec and returns the user's choice. With no blockers: yes exits Apollo Mode into the build posture (autonomous when available, else edit-approved) and starts building; yes-but-ask-first starts building with per-edit confirmation; hold keeps the session and drafts in Apollo Mode. With blockers, nothing changes mode.`
