import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from '../../utils/config.js'

export const BACKGROUND_LAUNCH_KEY = 'backgroundSessionsLaunchCrewmates'

export const BACKGROUND_LAUNCH_LABEL = 'Crewmates while backgrounded'

export const BACKGROUND_LAUNCH_DOORS = `the ${BACKGROUND_LAUNCH_LABEL} row of /config or of the boot menu's Agents section (one switch)`

export function backgroundSessionsLaunchCrewmates(): boolean {
  if (!isConfigReadingAllowed()) return false
  try {
    return getGlobalConfig()[BACKGROUND_LAUNCH_KEY] === true
  } catch {
    return false
  }
}

export function setBackgroundSessionsLaunchCrewmates(on: boolean): boolean {
  saveGlobalConfig(config => {
    if (on) return config[BACKGROUND_LAUNCH_KEY] === true ? config : { ...config, [BACKGROUND_LAUNCH_KEY]: true }
    if (config[BACKGROUND_LAUNCH_KEY] === undefined) return config
    const rest = { ...config }
    delete rest[BACKGROUND_LAUNCH_KEY]
    return rest
  })
  return on
}

export function backgroundLaunchValueWords(on: boolean): string {
  return on ? 'on' : 'off'
}

export function backgroundLaunchReceiptWords(on: boolean): string {
  return on
    ? `${BACKGROUND_LAUNCH_LABEL} on — a backgrounded session launches crewmates and workflows as a focused one does; a session born from now on carries the tools from its first request`
    : `${BACKGROUND_LAUNCH_LABEL} off — a backgrounded session waits for your visit or the workflows-allowed tag before it launches`
}

export const BACKGROUND_LAUNCH_SUMMARY =
  'whether a session you have left in the background may launch crewmates and workflows when its brief says so — off keeps it waiting for your visit or the workflows-allowed tag'

export function backgroundLaunchDetailLines(on: boolean = backgroundSessionsLaunchCrewmates()): string[] {
  return [
    `now: ${backgroundLaunchValueWords(on)}${on ? '' : ' (default)'}`,
    "the session's own Crewmates and Workflows switches still rule first; the one workflows-allowed tag stays what it is",
    `doors: ${BACKGROUND_LAUNCH_DOORS}`,
  ]
}

export const BACKGROUND_LAUNCH_MENU_ROW = {
  env: BACKGROUND_LAUNCH_KEY,
  label: BACKGROUND_LAUNCH_LABEL,
  group: 'agents',
  kind: 'toggle',
  options: ['on'],
  defaultLabel: 'off',
  applicationClass: 'live',
  summary: BACKGROUND_LAUNCH_SUMMARY,
  detail: {
    controls:
      "Whether a session running in the background — one your terminal has left, or one born there — may launch crewmates and workflows. Off (the default): a backgrounded session keeps working single-handed and waits until you visit it or until it holds the one workflows-allowed tag. On: it launches as a focused session does, under its own permission mode and its own Crewmates and Workflows switches; a session born while this is on carries the Agent and Workflow tools from its first request. One switch for every backgrounded session; the same row in /config.",
    on: ['a backgrounded session whose brief tells it to delegate launches crewmates and workflows without your visit', "the session's own Crewmates and Workflows switches still rule first", 'the workflows-allowed tag is untouched: it still admits one tagged session'],
    off: ['a backgrounded session waits for your visit or the workflows-allowed tag; its launch refusal names this row', 'a focused session launches as it always has'],
  },
} as const
