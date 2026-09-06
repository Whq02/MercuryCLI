
const RUNNER_OPTIONS: Readonly<Record<string, 0 | 1 | 'many'>> = {
  '--system-prompt': 1,
  '--system-prompt-file': 1,
  '--append-system-prompt': 1,
  '--append-system-prompt-file': 1,
  '--thinking': 1,
  '--agent': 1,
  '--agents': 1,
  '--allowed-tools': 'many',
  '--disallowed-tools': 'many',
  '--tools': 'many',
  '--mcp-config': 'many',
  '--strict-mcp-config': 0,
  '--add-dir': 'many',
  '--settings': 1,
  '--setting-sources': 1,
  '--fallback-model': 1,
  '--betas': 'many',
  '--bare': 0,
  '--extension': 1,
  '--disable-slash-commands': 0,
  '--workload': 1,
  '--debug-file': 1,
}

export function runnerArgvFromBoot(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    const eq = token.indexOf('=')
    const flag = eq === -1 ? token : token.slice(0, eq)
    const arity = RUNNER_OPTIONS[flag]
    if (arity === undefined) continue
    out.push(token)
    if (eq !== -1 || arity === 0) continue
    if (arity === 1) {
      const value = argv[i + 1]
      if (value !== undefined) {
        out.push(value)
        i += 1
      }
      continue
    }
    while (i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) {
      out.push(argv[i + 1]!)
      i += 1
    }
  }
  return out
}

export function refuseRunnerArgv(argv: unknown): string | null {
  if (!Array.isArray(argv)) return 'runnerArgv must be a list of tokens'
  if (argv.length > 64) return 'runnerArgv carries more than 64 tokens'
  for (const token of argv) {
    if (typeof token !== 'string' || token.length === 0) return 'runnerArgv tokens must be non-empty strings'
    if (token.length > 8192) return 'a runnerArgv token exceeds 8192 characters'
  }
  const tokens = argv as string[]
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const eq = token.indexOf('=')
    const flag = eq === -1 ? token : token.slice(0, eq)
    const arity = RUNNER_OPTIONS[flag]
    if (arity === undefined) return `'${flag}' is not a runner option`
    if (eq !== -1 || arity === 0) continue
    if (arity === 1) {
      if (tokens[i + 1] === undefined) return `'${flag}' needs a value`
      i += 1
      continue
    }
    while (i + 1 < tokens.length && !tokens[i + 1]!.startsWith('-')) i += 1
  }
  return null
}

export function splitAppendSystemPrompt(argv: readonly string[]): { rest: string[]; append: string | null } {
  const rest: string[] = []
  let append: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--append-system-prompt' && argv[i + 1] !== undefined) {
      append = argv[i + 1]!
      i += 1
      continue
    }
    if (token.startsWith('--append-system-prompt=')) {
      append = token.slice('--append-system-prompt='.length)
      continue
    }
    rest.push(token)
  }
  return { rest, append }
}
