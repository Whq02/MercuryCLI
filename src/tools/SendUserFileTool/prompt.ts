// String constants for the SendUserFile tool. The tool NAME is a wire value
// (it appears in requests and persisted transcripts) and must stay stable;
// the description and prompt are model-facing guidance.

export const SEND_USER_FILE_TOOL_NAME = 'SendUserFile'

export const DESCRIPTION = 'Deliver one or more local files to the user'

export const SEND_USER_FILE_TOOL_PROMPT = `Deliver files to the user. Reach for this when the file itself is the deliverable — a rendered diagram, a finished report, a screenshot, a built artifact — and it belongs in front of them rather than buried in a mention. Paths may be absolute or relative to the current working directory.

Add a \`caption\` only when one line of context earns its place ("row 42 is the failing case", "left: before, right: after"). A file that explains itself needs none.

Every call sets \`status\`. Pick \`proactive\` when you are the one initiating — the user is away and this should reach them (an artifact finished building, a report is ready). Pick \`normal\` when the delivery answers something they just said.

The tool ships files that already exist on the local filesystem; it does not fetch URLs and it does not render content. If a path is uncertain, list the directory first — absolute paths leave no ambiguity about the working directory.`
