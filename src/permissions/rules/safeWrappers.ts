export function stripComments(command: string): string {
  const lines = command.split('\n')
  const kept = lines.filter(line => {
    const trimmed = line.trim()
    return trimmed.length > 0 && !trimmed.startsWith('#')
  })
  return kept.length === 0 ? command : kept.join('\n')
}

const SAFE_ASSIGN_VALUE = String.raw`[A-Za-z0-9_./:@%+,=-]*`

const SAFE_ENV_VARS: ReadonlySet<string> = new Set([
  'GOEXPERIMENT',
  'GOOS',
  'GOARCH',
  'CGO_ENABLED',
  'GO111MODULE',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'NODE_ENV',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
  'PYTEST_DEBUG',
  'ANTHROPIC_API_KEY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_TIME',
  'CHARSET',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TZ',
  'LS_COLORS',
  'LSCOLORS',
  'GREP_COLOR',
  'GREP_COLORS',
  'GCC_COLORS',
  'TIME_STYLE',
  'BLOCK_SIZE',
  'BLOCKSIZE',
])

const SAFE_ENV_PREFIX_RE = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)=${SAFE_ASSIGN_VALUE}[ \\t]+`)

const WRAPPER_COMMANDS = ['timeout', 'time', 'nice', 'stdbuf', 'nohup']

function stripOneWrapper(command: string): string {
  const headMatch = /^([a-z]+)[ \t]+([\s\S]+)$/.exec(command)
  if (!headMatch) return command
  const wrapper = headMatch[1]!
  if (!WRAPPER_COMMANDS.includes(wrapper)) return command
  let rest = headMatch[2]!

  if (wrapper === 'timeout') {
    rest = stripTimeoutFlags(rest)
    rest = rest.replace(/^--[ \t]+/, '')
    const durationMatch = /^\d+(?:\.\d+)?[smhd]?[ \t]+/.exec(rest)
    if (!durationMatch) return command
    rest = rest.slice(durationMatch[0].length)
  } else if (wrapper === 'nice') {
    rest = rest.replace(/^(?:-n[ \t]*[+-]?\d+|-\d+)[ \t]+/, '')
  } else if (wrapper === 'stdbuf') {
    const flagsMatch = /^(?:-[ioe](?:[ \t]+)?(?:L|N|\d+)[ \t]+)+/.exec(rest)
    if (!flagsMatch) return command
    rest = rest.slice(flagsMatch[0].length)
  }

  rest = rest.replace(/^--[ \t]+/, '').trim()
  return rest.length > 0 ? rest : command
}

export function stripSafeWrappers(command: string): string {
  let current = command.trim()
  let changed = true
  while (changed) {
    changed = false
    const withoutComments = stripComments(current).trim()
    if (withoutComments !== current) {
      current = withoutComments
      changed = true
      continue
    }
    const withoutEnv = stripLeadingSafeEnvVars(current).trim()
    if (withoutEnv !== current) {
      current = withoutEnv
      changed = true
      continue
    }
    const withoutWrapper = stripOneWrapper(current)
    if (withoutWrapper !== current) {
      current = withoutWrapper
      changed = true
    }
  }
  return current
}

export function stripLeadingSafeEnvVars(command: string): string {
  const match = SAFE_ENV_PREFIX_RE.exec(command)
  if (!match) return command
  const name = match[1]!
  if (!SAFE_ENV_VARS.has(name)) return command
  return command.slice(match[0].length)
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
