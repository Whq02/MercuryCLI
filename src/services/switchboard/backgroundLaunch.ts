import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from '../../utils/config.js'

export const BACKGROUND_LAUNCH_KEY = 'backgroundSessionsLaunchCrewmates'

export const BACKGROUND_LAUNCH_LABEL = 'Crewmates while backgrounded'

export const BACKGROUND_LAUNCH_DOORS = '/config · Boot Menu (one switch)'

export function backgroundSessionsLaunchCrewmates(): boolean {
  if (!isConfigReadingAllowed()) return false
  try {
    return getGlobalConfig()[BACKGROUND_LAUNCH_KEY] === true
  } catch {
    return false
  }
}

export function setBackgroundSessionsLaunchCrewmates(on: boolean, save: typeof saveGlobalConfig = saveGlobalConfig): boolean {
  save(config => {
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
    ? `${BACKGROUND_LAUNCH_LABEL} on — backgrounded sessions launch as a focused one does`
    : `${BACKGROUND_LAUNCH_LABEL} off — backgrounded sessions wait for a visit or the tag`
}

export const BACKGROUND_LAUNCH_SUMMARY =
  'whether a session you have left in the background may launch crewmates when its brief says so — off keeps it waiting for your visit or the crewmates-allowed tag'

export const BACKGROUND_LAUNCH_NOTE = "the session's own Crewmates switch still rules first; the one crewmates-allowed tag stays what it is"

export function backgroundLaunchDetailLines(on: boolean = backgroundSessionsLaunchCrewmates()): string[] {
  return [`now: ${backgroundLaunchValueWords(on)}${on ? '' : ' (default)'}`, `doors: ${BACKGROUND_LAUNCH_DOORS}`]
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
    controls: 'Whether a session left in the background may launch crewmates when its brief says so, as a focused one does.',
    on: ['launches crewmates without your visit', 'its own switch still rules first'],
    off: ['waits for your visit or the crewmates-allowed tag', 'the launch refusal names this row'],
  },
} as const

export function backgroundWorkerDelegationSentence(on: boolean = backgroundSessionsLaunchCrewmates()): string {
  return on
    ? `Delegation (crewmates) is available: the operator turned on ${BACKGROUND_LAUNCH_LABEL}, so this session launches crewmates as a focused one does — when the tool is absent, plan and work single-handed; never wait for it.`
    : `Delegation (crewmates) is available only while this session holds the crewmates-allowed tag, the operator is present, or the operator has turned on ${BACKGROUND_LAUNCH_LABEL} — when the tool is absent, plan and work single-handed; never wait for it.`
}
