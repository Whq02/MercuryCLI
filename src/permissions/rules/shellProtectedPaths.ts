import { getShellCwd } from '../../platform/shell/shellExec.js'
import { UNREAD_PART } from '../wards/wardsShellRead.js'
import { runtimeProcessRefusal, runtimeWritePath } from './runtimeProtection.js'
import { credentialStorePath, mercurySecretPath } from './shell-protected-paths/paths.js'
import { inlineScriptReads, inlineScriptWrites, normalizeInlineScript } from './shell-protected-paths/inlineScripts.js'
import { couldNameSecret, mercuryHomes, spellingsOf } from './shell-protected-paths/homes.js'
import { readCredentialWrite } from './shell-protected-paths/credentialWrite.js'
import { readSecretReach } from './shell-protected-paths/secretReach.js'
import { killOfNamedPid, readSelfProtection } from './shell-protected-paths/selfProtection.js'
export { inlineScriptWriteTargets } from './shell-protected-paths/inlineScripts.js'

export async function shellCredentialWritePath(command: string, powershell = false, cwd = getShellCwd()): Promise<string | null> {
  return readCredentialWrite(command, powershell, cwd)
}

export async function shellMercurySecretPath(command: string, powershell = false, cwd = getShellCwd()): Promise<string | null> {
  const reached = await readSecretReach(command, powershell, cwd)
  return reached === null ? null : reached.replaceAll(UNREAD_PART, '$(…)')
}

export async function shellSelfProtectionReason(command: string, powershell = false, cwd = getShellCwd()): Promise<string | null> {
  return readSelfProtection(command, powershell, cwd)
}

export async function evalCodePermission(code: string, cwd = getShellCwd()): Promise<{ behavior: 'deny'; message: string; decisionReason: { type: 'other'; reason: string } } | null> {
  const denyVerdict = (message: string) => ({ behavior: 'deny' as const, message, decisionReason: { type: 'other' as const, reason: message } })
  const spans = new Map<string, string>()
  const writes = inlineScriptWrites(code, spans)
  for (const target of writes) {
    const runtime = runtimeWritePath(target, cwd, true)
    if (runtime !== null) return denyVerdict('Changing ' + target + ' is refused: ' + runtime + ' is part of Mercury’s running runtime.\n' + spans.get(target))
  }
  for (const killCall of code.matchAll(/\b(?:process|os)\.kill\s*\(\s*(\d+)/g)) {
    const reason = await runtimeProcessRefusal([['kill', killCall[1]!]])
    if (reason) return denyVerdict(reason)
  }
  const killed = await killOfNamedPid(code)
  if (killed) return denyVerdict(killed)
  const normalized = normalizeInlineScript(code)
  for (const target of [...inlineScriptReads(code), ...[...normalized.matchAll(/(['"])([^'"\r\n]+)\1/g)].map(m => m[2]!)]) {
    const secret = mercurySecretPath(target, cwd)
    if (secret !== null) return denyVerdict('Reading ' + target + ' is refused: ' + secret + " holds Mercury's own credentials; use the product's sign-in and account surfaces instead.")
  }
  const homes = mercuryHomes()
  for (const literal of normalized.matchAll(/(['"])([^'"\r\n]+)\1/g)) {
    for (const word of literal[2]!.split(/\s+/)) {
      for (const candidate of spellingsOf(word)) {
        if (mercurySecretPath(candidate, cwd) !== null || couldNameSecret(candidate, cwd, homes)) return denyVerdict('Reading ' + word + ' is refused: it can name a file that holds Mercury\'s own credentials; use the product\'s sign-in and account surfaces instead.')
      }
    }
  }
  for (const target of inlineScriptWrites(code)) {
    const credential = credentialStorePath(target, cwd)
    if (credential !== null) return denyVerdict('Writing ' + target + ' is refused: ' + credential + ' is a protected system or credential path.')
  }
  return null
}
