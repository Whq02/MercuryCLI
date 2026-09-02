/**
 * Purely informational "this looks destructive" note for the PowerShell consent
 * dialog. It never affects permission logic or auto-approval. Patterns are
 * tried in order; the first match wins. All matching is case-insensitive.
 */

/** A statement-start anchor: string start, or after | ; & newline { or (. */
const STMT_START = String.raw`(?:^|[|;&\n{(])\s*`
/** Removal cmdlet names (contract data): Remove-Item and its aliases. */
const REMOVAL = String.raw`(?:Remove-Item|rm|del|rd|rmdir|ri)`
/** Flag-region stopper for the removal rows: | ; & newline or }. */
const removalRegion = (cmd: string): string => {
  const start = new RegExp(`${STMT_START}${cmd}\\b`, 'i')
  return start.source
}

type Matcher = (command: string) => string | null

/** Extract the flag region of a removal command (stops at | ; & newline }), not at `)`. */
function removalFlags(command: string): string | null {
  const match = command.match(new RegExp(`${STMT_START}${REMOVAL}\\b([^|;&\\n}]*)`, 'i'))
  return match ? (match[1] as string) : null
}

const MATCHERS: Matcher[] = [
  // The Remove-Item family triggers only on the FULL -Recurse / -Force
  // parameter words (case-insensitive), never the short -r / -f forms.
  // Removal with BOTH recurse and force.
  command => {
    const region = removalFlags(command)
    if (region && /\s-recurse\b/i.test(region) && /\s-force\b/i.test(region)) {
      return 'Note: this could delete a whole directory tree, overriding protections.'
    }
    return null
  },
  // Removal with recurse.
  command => {
    const region = removalFlags(command)
    return region && /\s-recurse\b/i.test(region)
      ? 'Note: this could delete a whole directory tree.'
      : null
  },
  // Removal with force.
  command => {
    const region = removalFlags(command)
    return region && /\s-force\b/i.test(region)
      ? 'Note: this could delete files despite protections.'
      : null
  },
  // Clear-Content with a * in its argument region (stops at | ; & newline).
  command => {
    const match = command.match(/\bClear-Content\b([^|;&\n]*)/i)
    return match && (match[1] as string).includes('*')
      ? 'Note: this could empty more than one file.'
      : null
  },
  command => (/\bFormat-Volume\b/i.test(command) ? 'Note: this could format a volume.' : null),
  command => (/\bClear-Disk\b/i.test(command) ? 'Note: this could wipe a disk.' : null),
  command => (/\bgit\s+reset\b[^\n]*\s--hard\b/i.test(command) ? 'Note: this could throw away uncommitted work.' : null),
  // git push force (region stops at | ; & newline).
  command => {
    const match = command.match(/\bgit\s+push\b([^|;&\n]*)/i)
    return match && /\s(?:--force(?:-with-lease)?|-f)\b/i.test(match[1] as string)
      ? 'Note: this could rewrite what is on the remote.'
      : null
  },
  // git clean with force and without dry-run.
  command => {
    const match = command.match(/\bgit\s+clean\b([^|;&\n]*)/i)
    if (!match) return null
    const region = match[1] as string
    const force = /\s-[A-Za-z]*f|--force\b/i.test(region)
    const dryRun = /\s-[A-Za-z]*n|--dry-run\b/i.test(region)
    return force && !dryRun ? 'Note: this could delete untracked files irrecoverably.' : null
  },
  command => (/\bgit\s+stash\s+(?:drop|clear)\b/i.test(command) ? 'Note: this could destroy stashed work irrecoverably.' : null),
  command => (/\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i.test(command) ? 'Note: this could drop or empty database objects.' : null),
  command => (/\bStop-Computer\b/i.test(command) ? 'Note: this is going to power the machine off.' : null),
  command => (/\bRestart-Computer\b/i.test(command) ? 'Note: this is going to reboot the machine.' : null),
  command => (/\bClear-RecycleBin\b/i.test(command) ? "Note: this destroys the recycle bin's contents for good." : null),
]

/** Return the first matching destructive-command warning, or null. */
export function getDestructiveCommandWarning(command: string): string | null {
  for (const matcher of MATCHERS) {
    const warning = matcher(command)
    if (warning) return warning
  }
  return null
}
