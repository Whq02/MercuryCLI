import { ARTIFACTS_LIST_TOOL_NAME } from './constants.js'

export const DESCRIPTION =
  'List durable artifacts (outputs persisted by prior autonomous/daemon runs) for this project, and optionally retrieve one by id'

export const ARTIFACTS_LIST_TOOL_PROMPT = `Lists the durable artifacts persisted for the current project scope — the final outputs (reports, summaries, generated text) that prior autonomous/daemon runs produced and saved, newest first.

Each entry shows the artifact's id, name, kind, when it was created, and its size. Pass an \`id\` to retrieve that artifact's full content along with its metadata.

This closes the autonomy loop: a run produces an output, persists it as an artifact, and a LATER session/agent uses ${ARTIFACTS_LIST_TOOL_NAME} to find and read it instead of the output vanishing. Read-only — it never writes or deletes anything.

Use ${ARTIFACTS_LIST_TOOL_NAME} when you wake up to see what prior runs produced, or to pull back a specific earlier result before deciding what to do next. If nothing has been persisted for this project, the list is empty and says so.`
