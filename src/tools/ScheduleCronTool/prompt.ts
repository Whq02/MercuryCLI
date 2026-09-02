import { getIsSessionOneShotHeadless } from '../../bootstrap/state.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

/**
 * The scheduling tools' gates, the three tool names, and the model-facing
 * scheduling doctrine — SATURN's tool surface (the scheduler reborn): a
 * schedule is a SESSION FACT on the durable session record, fired by the
 * daemon, receipted, and visible on the operator's board.
 */

/** Tool names — transcript contract data. */
export const CRON_CREATE_TOOL_NAME = 'CronCreate'
export const CRON_DELETE_TOOL_NAME = 'CronDelete'
export const CRON_LIST_TOOL_NAME = 'CronList'

/** The board command the operator inspects schedules on (contract data). */
export const SATURN_BOARD_COMMAND = '/saturn'

/**
 * The master gate every scheduling tool's enablement reads: SATURN's own
 * kill switch (MERCURY_SATURN_DISABLE — the registered engine kill) turns
 * the surface off; otherwise Mercury ships it on unconditionally. The flag
 * is read HERE rather than through saturnTicker's isSaturnDisabled because
 * this module is a leaf of constants/tools.ts — pulling the daemon graph
 * in created a circular-import TDZ on the tool-name constants (found live
 * at S6b; prove-saturn-core pins the two reads equal).
 */
export function isSaturnSchedulingEnabled(): boolean {
  return !isEnvTruthy(flagEnv('MERCURY_SATURN_DISABLE'))
}

/**
 * Whether the scheduling tools belong in THIS session's roster: the master
 * gate AND not a one-shot headless print run — a one-shot run cannot take a
 * later fire (the run ends with its turn), so a scheduling tool there is an
 * OFF surface. Interactive and streaming-input sessions mount as before.
 * Read live per catalogue build.
 */
export function cronToolsMountable(): boolean {
  if (!isSaturnSchedulingEnabled()) return false
  // The one-shot fact lives on the single bootstrap posture the headless
  // entry writes — reading it here (not a cockpit module) guarantees this
  // gate and the entry share one instance in the bundle.
  return !getIsSessionOneShotHeadless()
}

/**
 * Whether a non-interactive (`-p`) session takes scheduled/self-paced
 * fires: exactly the streaming-input flag. A one-shot print run must not
 * (a fire mid-turn silently extends a run the operator sized as one turn);
 * a long-lived streaming-input worker must (its self-pacing wakes ride the
 * seat road or the process-local sink). Pure.
 */
export function forkHeadlessCronEligible(streamingInput: boolean): boolean {
  return streamingInput
}

export function buildCronCreateDescription(): string {
  return "Put a prompt on this session's clock: run it once at a future moment, or repeatedly on a 5-field cron expression (local timezone). The schedule is a session fact — it rides the session's durable record, the daemon fires it (even into a parked session), and every fire leaves a receipt."
}

export function buildCronCreatePrompt(): string {
  return `Put a prompt on this session's clock — one future run, or a recurring schedule.

## Cron expressions
- The expression is standard 5-field cron (\`minute hour day-of-month month day-of-week\`).
- Times read in the user's LOCAL timezone — never convert to UTC.

## One-shot schedules
- Pin the minute, hour, day-of-month and month, and pass recurring: false. The schedule fires once and then removes itself.
- "remind me at 3:47pm" (today) → cron: "47 15 <today's day> <today's month> *", recurring: false
- "tomorrow morning" → cron: "0 9 <tomorrow's day> <tomorrow's month> *", recurring: false

## Recurring schedules
- Every 5 minutes → "*/5 * * * *"
- Every hour at :07 → "7 * * * *"
- Weekdays at 9am → "0 9 * * 1-5"

## How it lands
- The submission travels to the daemon on the session's next facts beat and is applied to the SESSION RECORD there — this call answers "submitted", and ${CRON_LIST_TOOL_NAME} shows the applied schedule with its id shortly after (the id is minted by the daemon, not by this call).
- The schedule runs on THIS session's own model and account. If the account's sign-in expires or rate-limits at fire time, the fire is HELD and receipted ("/logins releases held fires") — never dropped silently, never run on another account.
- A fire due while the session is parked wakes it by default; pass onParked: "queue" to hold the fire for the session's own next wake instead.
- A fire that comes due while the machine was asleep runs late within the catch-up window (receipted as late); beyond it, it is recorded as missed — never silently dropped.

## Result
- The user can inspect and manage every schedule — next fire, kind, held fires — on the ${SATURN_BOARD_COMMAND} board and the session receipts. Mention that board when you schedule something.
- Cancel with ${CRON_DELETE_TOOL_NAME}, using the id ${CRON_LIST_TOOL_NAME} shows.`
}

export const CRON_DELETE_DESCRIPTION = "Take a schedule off this session's clock, by id."

export function buildCronDeletePrompt(): string {
  return `Cancel a schedule on this session's record. Pass the id ${CRON_LIST_TOOL_NAME} shows (ids are minted by the daemon when a submission lands). The removal travels on the session's next facts beat and is receipted.`
}

export const CRON_LIST_DESCRIPTION = "List this session's schedules."

export function buildCronListPrompt(): string {
  return `List this session's schedules as the daemon last pushed them: id, human-readable timing, one-shot or recurring, fire-into-session or session-birth, next fire, paused state. A submission from ${CRON_CREATE_TOOL_NAME} appears here once the daemon applies it (the next facts beat).`
}
