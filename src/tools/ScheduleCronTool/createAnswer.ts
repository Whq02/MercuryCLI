import type { ScheduleEditAnswer } from '../../services/saturn/sessionScheduleBridge.js'
import type { CreateOutput } from './CronCreateTool.js'
import { createLocalTime, createUntil } from './createTime.js'

export function scheduleRefusal(detail: string): string {
  const family = /no-credential:([^\s—]+)/.exec(detail)?.[1]
  const next = family ? `The schedule would run on this session's model, and no ${family} account is connected: tell the user, and call CronCreate again once one is.`
    : detail.includes('unknown-family:') ? "This session's model names no provider Mercury can schedule on: tell the user; retrying on this session will not help."
    : detail.includes('unreachable:local') ? 'The local model server is not answering: tell the user, and call CronCreate again once it answers.'
    : detail.includes('already holds 50 schedules') ? 'Call CronList, remove one with CronDelete, then call CronCreate again.'
    : detail.includes('unknown-session:') ? 'The daemon holds no live record for this session (it has ended): tell the user; nothing can be scheduled on it.'
    : detail.includes('could not mint an unused id') ? 'Call CronCreate once more.'
    : 'Fix what it names, then call CronCreate again.'
  return `CronCreate: the daemon refused this schedule, so nothing was scheduled. It said: "${detail}". ${next} Nothing was scheduled.`
}

export function scheduleUnconfirmed(reason: string, when: string): string {
  return `CronCreate: NOT confirmed. ${reason}, so this call cannot tell whether the schedule landed. Call CronList next: a row reading "${when}" is this schedule and carries its id. Call CronCreate again only if no such row appears.`
}

export function scheduleQueued(when: string, older: boolean): string {
  const cause = older ? 'is an older build that cannot answer schedule requests' : 'could not be asked directly'
  return `Queued, not confirmed: the daemon hosting this session ${cause}, so this call has no id and cannot see a refusal. Do not tell the user it is scheduled yet. Call CronList in a few seconds: a row reading "${when}" is this schedule, with its id; if none appears, the daemon refused it. Tell the user.`
}

export function scheduleWarnings(answer: ScheduleEditAnswer, recurring: boolean): string[] {
  const p = answer.preflight
  const family = answer.family ?? 'schedule account'
  const zone = answer.time_zone!
  switch (p?.state) {
    case 'expiring': return p.expires_at === undefined ? [] : [`Warning: the ${family} sign-in expires ${createLocalTime(p.expires_at, zone)}, before ${recurring ? 'the next fire' : 'this fire'}; a fire due after that is held (not dropped) until /logins renews the sign-in. Tell the user.`]
    case 'expired': return [`Warning: the ${family} sign-in has expired; every fire is held (not dropped) until /logins renews it. Tell the user.`]
    case 'signed-out': return [`Warning: no ${family} account is signed in; every fire is held (not dropped) until /logins connects one. Tell the user.`]
    case 'unreachable': return ['Warning: the local model server is not answering; a fire due while it is down is held (not dropped) until it answers. Tell the user.']
    case 'rate-limited': return [p.retry_at === undefined ? `Warning: ${family} is rate-limited right now; a fire due while it is limited is held and released after.` : `Warning: ${family} is rate-limited until ${createLocalTime(p.retry_at, zone)}; a fire due before then is held and released after.`]
    default: return []
  }
}

export function createResultText(output: CreateOutput): string {
  if (output.state === 'queued') return output.note
  const named = output.title !== undefined ? ` "${output.title}"` : ''
  if (output.state !== 'scheduled') return `${output.recurring ? 'Recurring' : 'One-shot'} schedule${named} submitted: ${output.humanSchedule}. ${output.note}`
  const instant = `${output.nextFireLocal} (${output.nextFireUtc}), ${createUntil(output.nextFireMs!, Date.now())}`
  const cadence = output.humanSchedule === output.cron ? `cron "${output.cron}"` : `${output.humanSchedule} (cron "${output.cron}")`
  const first = output.recurring
    ? `Scheduled ${output.id}${named}, recurring: ${cadence}, read in ${output.timeZone}.\nNext fire: ${instant}.`
    : `Scheduled ${output.id}${named}, one run: ${instant}; then it removes itself.`
  return [first, output.note, ...(output.warnings ?? [])].join('\n')
}
