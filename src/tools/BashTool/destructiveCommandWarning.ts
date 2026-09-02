/**
 * Purely informational "this looks destructive" note for the permission
 * dialog. It never changes a permission decision or an auto-approval — it only
 * gives the human a heads-up. The matching is textual and deliberately
 * over-triggers, so every message is hedged ("may …") and opens by marking
 * itself as a note; a false positive is cheap, a missed warning is not.
 */

/** Trailing metacharacters that end one command segment. */
const SEGMENT_BOUNDARY = String.raw`(?:^|[;&|])\s*`

/** The first single-dash flag cluster after a command word, e.g. `-rf`. */
function firstFlagCluster(afterCommand: string): string | null {
  // Skip whitespace, then require a lone-dash cluster (not `--long`).
  const match = afterCommand.match(/^\s+-([A-Za-z]+)(?:\s|$)/)
  return match ? (match[1] as string) : null
}

/** Each matcher returns its note or null; declaration order is precedence. */
type Matcher = (command: string) => string | null

const MATCHERS: Matcher[] = [
  // git reset --hard
  command =>
    /\bgit\s+reset\b[^\n]*\s--hard\b/.test(command)
      ? 'Note: a hard reset may discard uncommitted changes.'
      : null,

  // git push --force / --force-with-lease / -f within one segment
  command =>
    new RegExp(`${SEGMENT_BOUNDARY}git\\s+push\\b[^;&|\\n]*\\s(?:--force(?:-with-lease)?|-f)\\b`).test(
      command,
    )
      ? 'Note: a force push may overwrite remote history.'
      : null,

  // git clean with a force flag and no dry-run flag
  command => {
    if (!/\bgit\s+clean\b/.test(command)) return null
    const segment = command.match(/git\s+clean\b[^;&|\n]*/)?.[0] ?? ''
    // The force letter `f` — and the dry-run letter `n` — count ANYWHERE in
    // a short-flag cluster (`-fd`, `-nf`), not only as its last letter.
    const hasForce = /\s(?:-[A-Za-z]*f[A-Za-z]*|--force)\b/.test(segment)
    const hasDryRun = /\s(?:-[A-Za-z]*n[A-Za-z]*|--dry-run)\b/.test(segment)
    return hasForce && !hasDryRun
      ? 'Note: a forced git clean may permanently delete untracked files.'
      : null
  },

  // git checkout . (optionally after --) at the end of a segment
  command =>
    /\bgit\s+checkout\b[^\n]*?(?:\s--)?\s+\.\s*(?:[;&|]|$)/.test(command)
      ? 'Note: checking out the current directory may discard all working tree changes.'
      : null,

  // git restore . (same shape)
  command =>
    /\bgit\s+restore\b[^\n]*?(?:\s--)?\s+\.\s*(?:[;&|]|$)/.test(command)
      ? 'Note: restoring the current directory may discard all working tree changes.'
      : null,

  // git stash drop / clear
  command =>
    /\bgit\s+stash\s+(?:drop|clear)\b/.test(command)
      ? 'Note: this may permanently remove stashed changes.'
      : null,

  // git branch force-delete: exact -D, or --delete --force in either order
  command => {
    if (!/\bgit\s+branch\b/.test(command)) return null
    const segment = command.match(/git\s+branch\b[^;&|\n]*/)?.[0] ?? ''
    // `-D` warns only when a branch name follows it (horizontal whitespace
    // after the flag); a bare `git branch -D` at end-of-string does not.
    const shortForce = /\s-D[ \t]+/.test(segment)
    const longForce =
      /\s--delete\b[^\n]*\s--force\b/.test(segment) || /\s--force\b[^\n]*\s--delete\b/.test(segment)
    return shortForce || longForce ? 'Note: this may force-delete a branch.' : null
  },

  // git commit / push / merge with --no-verify
  command =>
    /\bgit\s+(?:commit|push|merge)\b[^\n]*\s--no-verify\b/.test(command)
      ? 'Note: skipping verification may bypass safety hooks.'
      : null,

  // git commit --amend
  command =>
    /\bgit\s+commit\b[^\n]*\s--amend\b/.test(command)
      ? 'Note: amending may rewrite the last commit.'
      : null,

  // rm — recursive AND force in one cluster (most specific first)
  command => {
    const cluster = rmFirstCluster(command)
    if (cluster && /[rR]/.test(cluster) && /f/.test(cluster)) {
      return 'Note: this may recursively force-remove files.'
    }
    return null
  },
  // rm — recursive
  command => {
    const cluster = rmFirstCluster(command)
    return cluster && /[rR]/.test(cluster)
      ? 'Note: this may recursively remove files.'
      : null
  },
  // rm — force
  command => {
    const cluster = rmFirstCluster(command)
    return cluster && /f/.test(cluster) ? 'Note: this may force-remove files.' : null
  },

  // SQL DROP / TRUNCATE of a table, database or schema
  command =>
    /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i.test(command)
      ? 'Note: this may drop or truncate database objects.'
      : null,

  // SQL DELETE FROM with nothing before the terminator
  command =>
    /\bdelete\s+from\s+\S+\s*;?\s*$/i.test(command)
      ? 'Note: this may delete all rows from a database table.'
      : null,

  // kubectl delete
  command =>
    /\bkubectl\s+delete\b/.test(command) ? 'Note: this may delete Kubernetes resources.' : null,

  // terraform destroy
  command =>
    /\bterraform\s+destroy\b/.test(command)
      ? 'Note: this may destroy Terraform infrastructure.'
      : null,
]

/** The first flag cluster of a segment-anchored `rm`, or null. */
function rmFirstCluster(command: string): string | null {
  const match = command.match(new RegExp(`${SEGMENT_BOUNDARY}rm\\b([^;&|\\n]*)`))
  if (!match) return null
  return firstFlagCluster(match[1] as string)
}

/**
 * Return the first matching destructive-command warning, or null. Patterns are
 * tested in declaration order and the first hit wins — the three `rm` entries
 * are ordered most-specific first for that reason.
 */
export function getDestructiveCommandWarning(command: string): string | null {
  for (const matcher of MATCHERS) {
    const warning = matcher(command)
    if (warning) return warning
  }
  return null
}
