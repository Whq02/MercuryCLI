
const SEGMENT_BOUNDARY = String.raw`(?:^|[;&|])\s*`

function firstFlagCluster(afterCommand: string): string | null {
  const match = afterCommand.match(/^\s+-([A-Za-z]+)(?:\s|$)/)
  return match ? (match[1] as string) : null
}

type Matcher = (command: string) => string | null

const MATCHERS: Matcher[] = [
  command =>
    /\bgit\s+reset\b[^\n]*\s--hard\b/.test(command)
      ? 'Note: a hard reset may discard uncommitted changes.'
      : null,

  command =>
    new RegExp(`${SEGMENT_BOUNDARY}git\\s+push\\b[^;&|\\n]*\\s(?:--force(?:-with-lease)?|-f)\\b`).test(
      command,
    )
      ? 'Note: a force push may overwrite remote history.'
      : null,

  command => {
    if (!/\bgit\s+clean\b/.test(command)) return null
    const segment = command.match(/git\s+clean\b[^;&|\n]*/)?.[0] ?? ''
    const hasForce = /\s(?:-[A-Za-z]*f[A-Za-z]*|--force)\b/.test(segment)
    const hasDryRun = /\s(?:-[A-Za-z]*n[A-Za-z]*|--dry-run)\b/.test(segment)
    return hasForce && !hasDryRun
      ? 'Note: a forced git clean may permanently delete untracked files.'
      : null
  },

  command =>
    /\bgit\s+checkout\b[^\n]*?(?:\s--)?\s+\.\s*(?:[;&|]|$)/.test(command)
      ? 'Note: checking out the current directory may discard all working tree changes.'
      : null,

  command =>
    /\bgit\s+restore\b[^\n]*?(?:\s--)?\s+\.\s*(?:[;&|]|$)/.test(command)
      ? 'Note: restoring the current directory may discard all working tree changes.'
      : null,

  command =>
    /\bgit\s+stash\s+(?:drop|clear)\b/.test(command)
      ? 'Note: this may permanently remove stashed changes.'
      : null,

  command => {
    if (!/\bgit\s+branch\b/.test(command)) return null
    const segment = command.match(/git\s+branch\b[^;&|\n]*/)?.[0] ?? ''
    const shortForce = /\s-D[ \t]+/.test(segment)
    const longForce =
      /\s--delete\b[^\n]*\s--force\b/.test(segment) || /\s--force\b[^\n]*\s--delete\b/.test(segment)
    return shortForce || longForce ? 'Note: this may force-delete a branch.' : null
  },

  command =>
    /\bgit\s+(?:commit|push|merge)\b[^\n]*\s--no-verify\b/.test(command)
      ? 'Note: skipping verification may bypass safety hooks.'
      : null,

  command =>
    /\bgit\s+commit\b[^\n]*\s--amend\b/.test(command)
      ? 'Note: amending may rewrite the last commit.'
      : null,

  command => {
    const cluster = rmFirstCluster(command)
    if (cluster && /[rR]/.test(cluster) && /f/.test(cluster)) {
      return 'Note: this may recursively force-remove files.'
    }
    return null
  },
  command => {
    const cluster = rmFirstCluster(command)
    return cluster && /[rR]/.test(cluster)
      ? 'Note: this may recursively remove files.'
      : null
  },
  command => {
    const cluster = rmFirstCluster(command)
    return cluster && /f/.test(cluster) ? 'Note: this may force-remove files.' : null
  },

  command =>
    /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i.test(command)
      ? 'Note: this may drop or truncate database objects.'
      : null,

  command =>
    /\bdelete\s+from\s+\S+\s*;?\s*$/i.test(command)
      ? 'Note: this may delete all rows from a database table.'
      : null,

  command =>
    /\bkubectl\s+delete\b/.test(command) ? 'Note: this may delete Kubernetes resources.' : null,

  command =>
    /\bterraform\s+destroy\b/.test(command)
      ? 'Note: this may destroy Terraform infrastructure.'
      : null,
]

function rmFirstCluster(command: string): string | null {
  const match = command.match(new RegExp(`${SEGMENT_BOUNDARY}rm\\b([^;&|\\n]*)`))
  if (!match) return null
  return firstFlagCluster(match[1] as string)
}

export function getDestructiveCommandWarning(command: string): string | null {
  for (const matcher of MATCHERS) {
    const warning = matcher(command)
    if (warning) return warning
  }
  return null
}
