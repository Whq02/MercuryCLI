const SEGMENT_BOUNDARY = String.raw`(?:^|[;&|])\s*`

function firstFlagCluster(afterCommand: string): string | null {
  const match = afterCommand.match(/^\s+-([A-Za-z]+)(?:\s|$)/)
  return match ? (match[1] as string) : null
}

type Matcher = (command: string) => string | null

const DESTRUCTIVE_VERBS = [
  'rm',
  'rmdir',
  'del',
  'erase',
  'git reset',
  'git clean',
  'git checkout',
  'git restore',
  'git stash drop',
  'git stash clear',
  'git branch',
  'kubectl delete',
  'terraform destroy',
  'drop',
  'truncate',
  'delete',
] as const

const DOWNLOADER_COMMANDS = new Set([
  'iwr',
  'irm',
  'invoke-webrequest',
  'invoke-restmethod',
  'curl',
  'wget',
])

const FORCE_STOP_CMDLETS = new Set([
  'stop-service',
  'spsv',
  'stop-process',
  'spps',
  'remove-itemproperty',
  'rp',
])

const REMOVAL_COMMANDS = new Set([
  'remove-item',
  'ri',
  'rm',
  'rd',
  'rmdir',
  'del',
  'erase',
])

const CMD_REMOVAL_COMMANDS = new Set(['del', 'erase', 'rd', 'rmdir'])

const SYSTEM_PROCESS_NAMES = new Set([
  'system',
  'registry',
  'smss',
  'csrss',
  'wininit',
  'services',
  'lsass',
  'winlogon',
  'svchost',
])

function normalizeCommandName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/^\(+/, '').replace(/\.(?:exe|com|bat|cmd)$/i, '')
}

function hasWhatIfFlag(args: string[]): boolean {
  return args.some(arg => /^-whatif(?::(?:\$?true|1))?$/i.test(arg))
}

function isPowerShellRecurseFlag(arg: string): boolean {
  return /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::(?:\$?true|1))?$/i.test(arg)
}

function isPowerShellForceFlag(arg: string): boolean {
  return /^-fo(?:r(?:c(?:e)?)?)?(?::(?:\$?true|1))?$/i.test(arg)
}

function isEncodedCommandFlag(arg: string): boolean {
  return /^-(?:ec|e(?:n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?)$/i.test(arg)
}

function hasCmdRecursiveQuiet(args: string[]): boolean {
  let hasS = false
  let hasQ = false
  for (const arg of args) {
    const lower = arg.toLowerCase()
    if (lower === '/s') hasS = true
    else if (lower === '/q') hasQ = true
    else if (lower === '/sq' || lower === '/qs') {
      hasS = true
      hasQ = true
    }
  }
  return hasS && hasQ
}

function isRootOrHomeTarget(arg: string): boolean {
  const cleaned = arg.trim().replace(/^["']|["']$/g, '')
  if (!cleaned) return false
  if (/^[a-z]:[\\/]*$/i.test(cleaned)) return true
  if (/^[/\\]+$/.test(cleaned)) return true
  if (/^(?:~|\$home|\$env:userprofile|%userprofile%)[\\/]*$/i.test(cleaned)) return true
  if (/^(?:[a-z]:)?[\\/](?:users|home)(?:[\\/][^\\/]+)?[\\/]*$/i.test(cleaned)) return true
  return false
}

function isRecursiveForceRemoval(name: string, args: string[]): boolean {
  if (args.some(isPowerShellRecurseFlag) && args.some(isPowerShellForceFlag)) return true
  if (CMD_REMOVAL_COMMANDS.has(name) && hasCmdRecursiveQuiet(args)) return true
  if (name === 'rm') {
    let hasR = false
    let hasF = false
    for (const arg of args) {
      if (/^-[a-zA-Z]+$/.test(arg)) {
        if (/[rR]/.test(arg)) hasR = true
        if (arg.includes('f')) hasF = true
      } else if (arg === '--recursive') {
        hasR = true
      } else if (arg === '--force') {
        hasF = true
      }
    }
    if (hasR && hasF) return true
  }
  return false
}

function checkWindowsSegmentWarning(
  segments: { words: string[]; piped: boolean }[],
): string | null {
  let prevWasDownloader = false

  for (const segment of segments) {
    const { words, piped } = segment
    if (!piped) prevWasDownloader = false
    if (words.length === 0) continue

    const name = normalizeCommandName(words[0]!)
    const args = words.slice(1)
    const lowerArgs = args.map(arg => arg.toLowerCase())

    if (piped && prevWasDownloader && (name === 'iex' || name === 'invoke-expression')) {
      return 'Note: this downloads and executes remote code.'
    }
    if (
      DOWNLOADER_COMMANDS.has(name) ||
      (name === 'new-object' && /\bwebclient\b/i.test(words.join(' ')))
    ) {
      prevWasDownloader = true
    }

    if (name === 'vssadmin' && lowerArgs[0] === 'delete' && lowerArgs[1] === 'shadows') {
      return 'Note: this deletes shadow copies used for recovery.'
    }

    if (name === 'wbadmin' && lowerArgs[0] === 'delete') {
      return 'Note: this deletes backup recovery data.'
    }

    if (name === 'reg' && lowerArgs[0] === 'delete') {
      return 'Note: this deletes Windows registry data.'
    }

    if (name === 'diskpart' || name === 'format') {
      return 'Note: this may erase or repartition a disk or volume.'
    }

    if (name === 'format-volume' || name === 'clear-disk' || name === 'initialize-disk') {
      if (!hasWhatIfFlag(args)) {
        return 'Note: this may erase or repartition a disk or volume.'
      }
    }

    if (name === 'cipher' && lowerArgs.some(arg => /^\/w(?:[:=]|$)/.test(arg))) {
      return 'Note: this overwrites deleted data so it cannot be recovered.'
    }

    if (name === 'icacls') {
      const hasReset = lowerArgs.some(arg => arg === '/reset')
      let hasGrantEveryone = false
      for (let i = 0; i < lowerArgs.length; i++) {
        const arg = lowerArgs[i]!
        if (/^\/grant(?::r)?$/.test(arg) && /^everyone(?::|$)/.test(lowerArgs[i + 1] ?? '')) {
          hasGrantEveryone = true
          break
        }
        if (/^\/grant(?::r)?:everyone(?::|$)/.test(arg)) {
          hasGrantEveryone = true
          break
        }
      }
      if (hasReset || hasGrantEveryone) {
        return 'Note: this resets file permissions or grants access to everyone.'
      }
    }

    if (name === 'bcdedit' && lowerArgs.some(arg => arg === '/set')) {
      return 'Note: this changes Windows boot configuration.'
    }

    if (FORCE_STOP_CMDLETS.has(name) && !hasWhatIfFlag(args) && args.some(isPowerShellForceFlag)) {
      return 'Note: this forcibly stops a service or process, or removes registry properties.'
    }

    if (name === 'sc') {
      const sub = lowerArgs.find(arg => !arg.startsWith('\\\\'))
      if (sub === 'delete' || sub === 'stop') {
        return 'Note: this stops or deletes a Windows service.'
      }
    }

    if (REMOVAL_COMMANDS.has(name) && !hasWhatIfFlag(args)) {
      if (isRecursiveForceRemoval(name, args)) {
        const targets = args.filter(arg => !arg.startsWith('-') && !(CMD_REMOVAL_COMMANDS.has(name) && arg.startsWith('/')))
        if (targets.some(isRootOrHomeTarget)) {
          return 'Note: this recursively force-removes a root or home folder.'
        }
      }
      if (
        (CMD_REMOVAL_COMMANDS.has(name) && hasCmdRecursiveQuiet(args)) ||
        (name === 'rm' && args.some(isPowerShellRecurseFlag) && args.some(isPowerShellForceFlag))
      ) {
        return 'Note: this may recursively force-remove files.'
      }
    }

    if (name === 'taskkill' && lowerArgs.some(arg => arg === '/f' || arg === '-f')) {
      for (let i = 0; i < lowerArgs.length; i++) {
        const arg = lowerArgs[i]!
        if (arg === '/im' || arg === '-im') {
          const target = (lowerArgs[i + 1] ?? '').replace(/\.exe$/, '')
          if (SYSTEM_PROCESS_NAMES.has(target)) {
            return 'Note: this forcibly terminates a Windows system process.'
          }
        } else if (arg.startsWith('/im:') || arg.startsWith('-im:')) {
          const target = arg.slice(4).replace(/\.exe$/, '')
          if (SYSTEM_PROCESS_NAMES.has(target)) {
            return 'Note: this forcibly terminates a Windows system process.'
          }
        } else if (arg === '/pid' || arg === '-pid') {
          const pid = lowerArgs[i + 1] ?? ''
          if (pid === '0' || pid === '4') {
            return 'Note: this forcibly terminates a Windows system process.'
          }
        } else if (arg.startsWith('/pid:') || arg.startsWith('-pid:')) {
          const pid = arg.slice(5)
          if (pid === '0' || pid === '4') {
            return 'Note: this forcibly terminates a Windows system process.'
          }
        }
      }
    }

    if ((name === 'powershell' || name === 'pwsh') && args.some(isEncodedCommandFlag)) {
      return 'Note: this executes an encoded PowerShell command whose intent is hidden.'
    }
  }

  return null
}

const MATCHERS: Matcher[] = [
  command =>
    new RegExp(`${SEGMENT_BOUNDARY}git\\s+reset\\b[^;&|\\n]*(?:--hard|"--hard"|'--hard')(?:\\s|$|[;&|])`).test(command)
      ? 'Note: a hard reset may discard uncommitted changes.'
      : null,
  command =>
    new RegExp(`${SEGMENT_BOUNDARY}git\\s+push\\b[^;&|\\n]*(?:\\s-f(?:\\s|$)|--force(?:-with-lease)?\\b)`).test(command)
      ? 'Note: a force push may overwrite remote history.'
      : null,
  command => {
    const match = new RegExp(`${SEGMENT_BOUNDARY}git\\s+clean\\b([^;&|\\n]*)`).exec(command)
    if (!match) return null
    const rest = match[1] ?? ''
    const hasForce = /(?:^|\s)-[a-zA-Z]*f|--force\b/.test(rest)
    const hasDryRun = /(?:^|\s)-[a-zA-Z]*n|--dry-run\b/.test(rest)
    return hasForce && !hasDryRun ? 'Note: a forced git clean may permanently delete untracked files.' : null
  },
  command =>
    new RegExp(`${SEGMENT_BOUNDARY}git\\s+checkout\\s+(?:--\\s+)?\\.(?:\\s|$|[;&|])`).test(command)
      ? 'Note: checking out the current directory may discard all working tree changes.'
      : null,
  command =>
    new RegExp(`${SEGMENT_BOUNDARY}git\\s+restore\\s+(?:--\\s+)?\\.(?:\\s|$|[;&|])`).test(command)
      ? 'Note: restoring the current directory may discard all working tree changes.'
      : null,
  command =>
    new RegExp(`${SEGMENT_BOUNDARY}git\\s+stash\\s+(?:drop|clear)\\b`).test(command)
      ? 'Note: this may permanently remove stashed changes.'
      : null,
  command => {
    const match = new RegExp(`${SEGMENT_BOUNDARY}git\\s+branch\\b([^;&|\\n]*)`).exec(command)
    if (!match) return null
    const rest = match[1] ?? ''
    if (/(?:^|\s)-[a-zA-Z]*D(?:\s|$)/.test(rest)) return 'Note: this may force-delete a branch.'
    if (/(?:^|\s)--delete\b/.test(rest) && /(?:^|\s)--force\b/.test(rest)) {
      return 'Note: this may force-delete a branch.'
    }
    return null
  },
  command =>
    new RegExp(`${SEGMENT_BOUNDARY}git\\s+(?:commit|push|merge)\\b[^;&|\\n]*--no-verify\\b`).test(command)
      ? 'Note: skipping verification may bypass safety hooks.'
      : null,
  command =>
    new RegExp(`${SEGMENT_BOUNDARY}git\\s+commit\\b[^;&|\\n]*--amend\\b`).test(command)
      ? 'Note: amending may rewrite the last commit.'
      : null,
  command => {
    const re = new RegExp(`${SEGMENT_BOUNDARY}rm\\b([^;&|\\n]*)`, 'g')
    let match: RegExpExecArray | null
    while ((match = re.exec(command)) !== null) {
      const cluster = firstFlagCluster(match[1] ?? '')
      if (!cluster) continue
      const hasR = /[rR]/.test(cluster)
      const hasF = cluster.includes('f')
      if (hasR && hasF) return 'Note: this may recursively force-remove files.'
      if (hasR) return 'Note: this may recursively remove files.'
      if (hasF) return 'Note: this may force-remove files.'
    }
    return null
  },
  command =>
    /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i.test(command)
      ? 'Note: this may drop or truncate database objects.'
      : null,
  command =>
    /\bdelete\s+from\s+\S+\s*;?\s*$/i.test(command) && !/\bwhere\b/i.test(command)
      ? 'Note: this may delete all rows from a database table.'
      : null,
  command =>
    new RegExp(`${SEGMENT_BOUNDARY}kubectl\\s+delete\\b`).test(command)
      ? 'Note: this may delete Kubernetes resources.'
      : null,
  command =>
    new RegExp(`${SEGMENT_BOUNDARY}terraform\\s+destroy\\b`).test(command)
      ? 'Note: this may destroy Terraform infrastructure.'
      : null,
]

export function isDestructiveCommandVerb(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase()
  for (const verb of DESTRUCTIVE_VERBS) {
    if (normalized === verb || normalized.startsWith(`${verb} `)) return true
  }
  return getDestructiveCommandWarning(command) !== null
}

export function getDestructiveCommandWarning(command: string): string | null {
  const windowsWarning = checkWindowsSegmentWarning(shellCommandSegments(command))
  if (windowsWarning !== null) return windowsWarning
  for (const matcher of MATCHERS) {
    const warning = matcher(command)
    if (warning !== null) return warning
  }
  return null
}

export function shellCommandSegments(command: string): { words: string[]; piped: boolean }[] {
  const segments: { words: string[]; piped: boolean }[] = []
  let words: string[] = []
  let current = ''
  let inWord = false
  let quote: "'" | '"' | null = null
  let piped = false

  const flushWord = (): void => {
    if (inWord) {
      words.push(current)
      current = ''
      inWord = false
    }
  }

  const flushSegment = (nextPiped: boolean): void => {
    flushWord()
    if (words.length > 0) {
      segments.push({ words, piped })
      words = []
    }
    piped = nextPiped
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!

    if (quote === "'") {
      if (ch === "'") {
        quote = null
      } else {
        current += ch
      }
      continue
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if ((ch === '\\' || ch === '`') && i + 1 < command.length) {
        const next = command[i + 1]!
        if (ch === '`' || next === '"' || next === '\\') {
          current += next
          i++
        } else {
          current += ch
        }
      } else {
        current += ch
      }
      continue
    }

    if (ch === '`' && i + 1 < command.length) {
      current += command[i + 1]!
      inWord = true
      i++
      continue
    }

    if (ch === '\\' && i + 1 < command.length) {
      const next = command[i + 1]!
      if (next === ';' || next === '&' || next === '|') {
        current += next
        inWord = true
        i++
        continue
      }
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      inWord = true
      continue
    }

    if (ch === '#' && !inWord) {
      while (i < command.length && command[i] !== '\n' && command[i] !== '\r') {
        i++
      }
      if (i < command.length) {
        flushSegment(false)
      }
      continue
    }

    if (ch === ' ' || ch === '\t') {
      flushWord()
      continue
    }

    if (ch === '\n' || ch === '\r' || ch === ';') {
      flushSegment(false)
      continue
    }

    if (ch === '&') {
      if (command[i + 1] === '&') i++
      flushSegment(false)
      continue
    }

    if (ch === '|') {
      if (command[i + 1] === '|') {
        i++
        flushSegment(false)
      } else {
        flushSegment(true)
      }
      continue
    }

    current += ch
    inWord = true
  }

  flushSegment(false)
  return segments
}
