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

const DESTRUCTIVE_VERBS = [
  'rm', 'rmdir', 'del', 'erase', 'git reset', 'git clean', 'git checkout', 'git restore',
  'git stash drop', 'git stash clear', 'git branch', 'kubectl delete', 'terraform destroy',
  'drop', 'truncate', 'delete',
]

export function isDestructiveCommandVerb(command: string): boolean {
  const text = command.trim().toLowerCase().replace(/\s+/g, ' ')
  return DESTRUCTIVE_VERBS.some(verb => text === verb || text.startsWith(verb + ' ')) || getDestructiveCommandWarning(command) !== null
}

export function getDestructiveCommandWarning(command: string): string | null {
  const windows = windowsCommandWarning(command)
  if (windows !== null) return windows
  for (const matcher of MATCHERS) {
    const warning = matcher(command)
    if (warning) return warning
  }
  return null
}

export function shellCommandSegments(command: string): { words: string[]; piped: boolean }[] {
  const segments: { words: string[]; piped: boolean }[] = []
  let words: string[] = []
  let word = ''
  let quote = ''
  let piped = false
  const flushWord = () => { if (word !== '') words.push(word); word = '' }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (char === '`' && command[i + 1] !== undefined) { word += command[++i]; continue }
    if (quote !== '') {
      if (char === quote) quote = ''
      else word += char
      continue
    }
    if (char === '#' && word === '') {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++
      continue
    }
    if (char === '\\' && /[;&|]/.test(command[i + 1] ?? '')) { word += command[++i]; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (/[;&|\n\r]/.test(char)) {
      flushWord()
      if (words.length > 0) segments.push({ words, piped })
      words = []
      piped = char === '|'
    } else if (/\s/.test(char)) flushWord()
    else word += char
  }
  flushWord()
  if (words.length > 0) segments.push({ words, piped })
  return segments
}

function windowsCommandWarning(command: string): string | null {
  let downloader = false
  for (const segment of shellCommandSegments(command)) {
    const words = segment.words.map(word => word.toLowerCase())
    const name = (words[0]?.split(/[\\/]/).pop() ?? '').replace(/^\(+/, '').replace(/\.(exe|com)$/, '')
    const args = words.slice(1)
    if (!segment.piped) downloader = false
    if (['iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'curl', 'wget'].includes(name) || (name === 'new-object' && /webclient\b/.test(words.join(' ')))) downloader = true
    if (segment.piped && downloader && ['iex', 'invoke-expression'].includes(name)) return 'Note: this downloads and executes remote code.'
    if (['format-volume', 'clear-disk', 'initialize-disk', 'stop-service', 'spsv', 'stop-process', 'spps', 'remove-itemproperty', 'rp', 'remove-item', 'ri', 'rm', 'rd', 'rmdir', 'del', 'erase'].includes(name) && args.some(arg => /^-whatif(?::\$?true)?$/.test(arg))) continue
    if (name === 'vssadmin' && args[0] === 'delete' && args[1] === 'shadows') return 'Note: this deletes shadow copies used for recovery.'
    if (name === 'wbadmin' && args[0] === 'delete') return 'Note: this deletes backup recovery data.'
    if (name === 'reg' && args[0] === 'delete') return 'Note: this deletes Windows registry data.'
    if (['diskpart', 'format', 'format-volume', 'clear-disk', 'initialize-disk'].includes(name)) return 'Note: this may erase or repartition a disk or volume.'
    if (name === 'cipher' && args.some(arg => /^\/w(?::|$)/.test(arg))) return 'Note: this overwrites deleted data so it cannot be recovered.'
    if (name === 'icacls' && (args.includes('/reset') || args.some((arg, i) => /^\/grant(?::r)?$/.test(arg) && /^everyone(?::|$)/.test(args[i + 1] ?? '')))) return 'Note: this resets file permissions or grants access to everyone.'
    if (name === 'bcdedit' && args[0] === '/set') return 'Note: this changes Windows boot configuration.'
    const hasPsForce = args.some(arg => /^-(?:f|fo|for|forc|force)$/.test(arg))
    const hasPsRecurse = args.some(arg => /^-(?:r|re|rec|recu|recur|recurs|recurse)$/.test(arg))
    const hasCmdQuietRecurse = (args.includes('/s') && args.includes('/q')) || args.some(arg => /^\/(?:sq|qs)$/.test(arg))
    if (['stop-service', 'spsv', 'stop-process', 'spps', 'remove-itemproperty', 'rp'].includes(name) && hasPsForce) return 'Note: this forcibly stops a service or process, or removes registry properties.'
    if (name === 'sc' && ['delete', 'stop'].includes(args[0] ?? '')) return 'Note: this stops or deletes a Windows service.'
    if (['remove-item', 'ri', 'rm', 'rd', 'rmdir', 'del', 'erase'].includes(name) && ((hasPsRecurse && hasPsForce) || hasCmdQuietRecurse) && args.some(arg => /^(?:[a-z]:[\\/]*|[\\/]|~|\$home|\$env:userprofile|%userprofile%|[a-z]:[\\/]users[\\/][^\\/]+[\\/]*|\/(?:users|home)\/[^/]+\/?)$/.test(arg))) return 'Note: this recursively force-removes a root or home folder.'
    if (['del', 'erase', 'rd', 'rmdir'].includes(name) && hasCmdQuietRecurse) return 'Note: this may recursively force-remove files.'
    if (name === 'rm' && hasPsRecurse && hasPsForce) return 'Note: this may recursively force-remove files.'
    if (name === 'taskkill' && args.includes('/f') && args.some((arg, i) => arg === '/im' && /^(?:system|registry|smss|csrss|wininit|services|lsass|winlogon|svchost)(?:\.exe)?$/.test(args[i + 1] ?? '') || arg === '/pid' && ['0', '4'].includes(args[i + 1] ?? ''))) return 'Note: this forcibly terminates a Windows system process.'
    if (['powershell', 'pwsh'].includes(name) && args.some(arg => /^-(?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/.test(arg))) return 'Note: this executes an encoded PowerShell command whose intent is hidden.'
  }
  return null
}
