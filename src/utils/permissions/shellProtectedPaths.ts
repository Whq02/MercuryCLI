import { getShellCwd } from '../Shell.js'
import { UNREAD_PART } from '../wards/wardsShellRead.js'
import { runtimeProcessRefusal, runtimeWritePath } from './runtimeProtection.js'
import { credentialStorePath, mercurySecretPath } from './shellProtectedPaths/paths.js'
import { inlineScriptReads, inlineScriptWrites, normalizeInlineScript } from './shellProtectedPaths/inlineScripts.js'
import { couldNameSecret, mercuryHomes, spellingsOf } from './shellProtectedPaths/homes.js'
import { credentialWriteAfterMove, credentialWriteInBlocks, credentialWriteWalked } from './shellProtectedPaths/credentialWrite.js'
import { namedMercurySecretPath, readSecretReach } from './shellProtectedPaths/secretReach.js'
import { killOfNamedPid, namedSelfProtectionReason, readSelfProtection } from './shellProtectedPaths/selfProtection.js'
export { inlineScriptWriteTargets } from './shellProtectedPaths/inlineScripts.js'

export async function shellCredentialWritePath(command: string, powershell = false, cwd = getShellCwd()): Promise<string | null> {
  return (await credentialWriteWalked(command, powershell, cwd)) ?? (await credentialWriteAfterMove(command, powershell, cwd)) ?? credentialWriteInBlocks(command, powershell, cwd)
}

export async function shellMercurySecretPath(command: string, powershell = false, cwd = getShellCwd()): Promise<string | null> {
  const named = await namedMercurySecretPath(command, powershell, cwd)
  const reached = named ?? (await readSecretReach(command, powershell, cwd))
  return reached === null ? null : reached.replaceAll(UNREAD_PART, '$(…)')
}

export async function shellSelfProtectionReason(command: string, powershell = false, cwd = getShellCwd()): Promise<string | null> {
  const named = await namedSelfProtectionReason(command, powershell, cwd)
  return named ?? readSelfProtection(command, powershell, cwd)
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
