import { TICK_TAG } from '../../engine/message-shapes/messageTags.js'

export const SLEEP_TOOL_NAME = 'Sleep'

export const DESCRIPTION = 'Waits for a specified duration.'

export const SLEEP_TOOL_PROMPT = `Waits seconds without holding a shell, returning early on user interrupt, new input, or tracked crewmate/background-command completion (reporting why and elapsed time). Periodic <${TICK_TAG}> nudges may arrive during waits; each wake costs a model call, and prompt cache lapses after 5m idle.`

export const WORKER_MAX_SLEEP_SECONDS = 300

export const WORKER_SLEEP_LIMIT_NOTE = ` Waits over ${WORKER_MAX_SLEEP_SECONDS}s are refused in this worker environment.`
