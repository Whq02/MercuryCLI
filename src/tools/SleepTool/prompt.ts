import { TICK_TAG } from '../../constants/xml.js'

export const SLEEP_TOOL_NAME = 'Sleep'

export const DESCRIPTION = 'Waits for a specified duration.'

export const SLEEP_TOOL_PROMPT = `Waits the given seconds without holding a shell process, returning early when the user interrupts, new input arrives, or the crewmates and background commands it tracks finish; the result says which and reports the time actually waited. Periodic check-in prompts wrapped in <${TICK_TAG}> tags may arrive during the wait, each a nudge to look for useful work before sleeping on. Every wake is a model call, and the prompt cache lapses after 5 minutes of idleness.`
