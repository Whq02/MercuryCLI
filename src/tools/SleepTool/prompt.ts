import { TICK_TAG } from '../../constants/xml.js'

/**
 * The wait tool's name/description/prompt. The tool body lives in
 * SleepTool.tsx; only these three constants are owned here. The name is
 * transcript contract data.
 */
export const SLEEP_TOOL_NAME = 'Sleep'

export const DESCRIPTION = 'Waits for a specified duration.'

export const SLEEP_TOOL_PROMPT = `Wait out a given duration. An interrupt from the user ends the wait at once, reporting the time actually spent.

Use it when:
- a rest, hold, or break is what the user wants;
- genuinely nothing is actionable right now;
- you are waiting on something outside your control (a long build, an external process, a teammate's reply) and want to check back later.

While you sleep you may receive periodic check-in prompts wrapped in <${TICK_TAG}> tags. Treat each one as a nudge: look for useful work first (unread messages, finished tasks, pending follow-ups) and only go back to sleeping when there is still nothing to do.

You may call this tool concurrently with other tools — it does not interfere with them.

Prefer this tool over running \`sleep\` in the shell: it holds no shell process open, and it can be interrupted cleanly.

Waking is not free. Every wake-up is a model call, and the prompt cache lapses after 5 minutes of idleness, so a longer sleep costs less per unit of time waited while a shorter one reacts sooner. Choose the duration deliberately as that trade-off.`
