import { TICK_TAG } from '../../constants/xml.js'

export const SLEEP_TOOL_NAME = 'Sleep'

export const DESCRIPTION = 'Waits for a specified duration.'

export const SLEEP_TOOL_PROMPT = `Waits seconds without holding a shell, returning early on user interrupt, new input, or tracked crewmate/background-command completion (reporting why and elapsed time). Periodic <${TICK_TAG}> nudges may arrive during waits; each wake costs a model call, and prompt cache lapses after 5m idle.`
