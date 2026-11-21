export function stripComments(command: string): string {
  const lines = command.split('\n')
  const kept = lines.filter(line => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  })
  return kept.length === 0 ? command : kept.join('\n')
}

const SAFE_ENV_VARS = new Set([
  'GOEXPERIMENT', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GO111MODULE', 'RUST_BACKTRACE',
  'RUST_LOG', 'NODE_ENV', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE',
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD', 'PYTEST_DEBUG', 'ANTHROPIC_API_KEY', 'LANG',
  'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_TIME', 'CHARSET', 'TERM', 'COLORTERM',
  'NO_COLOR', 'FORCE_COLOR', 'TZ', 'LS_COLORS', 'LSCOLORS', 'GREP_COLOR',
  'GREP_COLORS', 'GCC_COLORS', 'TIME_STYLE', 'BLOCK_SIZE', 'BLOCKSIZE',
])

const SAFE_ASSIGN_VALUE = String.raw`[A-Za-z0-9_./:@%+,=-]*`

const WRAPPER_COMMANDS = ['timeout', 'time', 'nice', 'stdbuf', 'nohup']

export function stripSafeWrappers(command: string): string {
  let previous: string
  let current = command
  do {
    previous = current
    current = stripComments(current)
    current = stripLeadingSafeEnvVars(current)
    current = stripLeadingWrapper(current)
  } while (current !== previous)
  return current.trim()
}

export function stripLeadingSafeEnvVars(command: string): string {
  const match = command.match(new RegExp(`^([A-Za-z_]\\w*)=(${SAFE_ASSIGN_VALUE})[ \\t]+`))
  if (!match) return command
  if (!SAFE_ENV_VARS.has(match[1] as string)) return command
  return command.slice(match[0].length)
}

function stripLeadingWrapper(command: string): string {
  const word = command.match(/^(\S+)/)?.[1]
  if (!word || !WRAPPER_COMMANDS.includes(word)) return command
  let rest = command.slice(word.length).replace(/^[ \t]+/, '')
  if (word === 'timeout') {
    rest = stripTimeoutFlags(rest)
    rest = rest.replace(/^--[ \t]+/, '')
    rest = rest.replace(/^\d+(?:\.\d+)?[smhd]?[ \t]+/, '')
    return rest
  }
  if (word === 'nice') {
    rest = rest.replace(/^-n[ \t]+-?\d+[ \t]+/, '').replace(/^-\d+[ \t]+/, '')
  }
  if (word === 'stdbuf') {
    const flags = rest.match(/^(?:-[ioe](?:L|N|\d+)(?:[ \t]+|$))+/)
    if (!flags) return command
    rest = rest.slice(flags[0].length)
  }
  rest = rest.replace(/^--[ \t]+/, '')
  return rest
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
