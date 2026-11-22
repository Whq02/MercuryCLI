import { notBuilt } from '../../pi/holes.js'

export function stripComments(command: string): string {
  return notBuilt('src/utils/permissions/safeWrappers.ts:1')
}

const SAFE_ASSIGN_VALUE = String.raw`[A-Za-z0-9_./:@%+,=-]*`

const WRAPPER_COMMANDS = ['timeout', 'time', 'nice', 'stdbuf', 'nohup']

export function stripSafeWrappers(command: string): string {
  return notBuilt('src/utils/permissions/safeWrappers.ts:23')
}

export function stripLeadingSafeEnvVars(command: string): string {
  return notBuilt('src/utils/permissions/safeWrappers.ts:35')
}

function stripTimeoutFlags(rest: string): string {
  let out = rest
  const noValueLong = /^(?:--foreground|--preserve-status|--verbose)[ \t]+/
  const valueLong = /^(?:--kill-after|--signal)(?:=|[ \t]+)[A-Za-z0-9_.+-]+[ \t]+/
  const shortNoValue = /^-v[ \t]+/
  const shortValue = /^-[ks](?:[ \t]+)?[A-Za-z0-9_.+-]+[ \t]+/
  let changed = true
  while (changed) {
    changed = false
    for (const re of [noValueLong, valueLong, shortNoValue, shortValue]) {
      if (re.test(out)) {
        out = out.replace(re, '')
        changed = true
      }
    }
  }
  return out
}
