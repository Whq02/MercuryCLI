
const RUNNER_OPTIONS: Readonly<Record<string, 0 | 1 | 'many'>> = {
  '--brief': 1,
  '--brief-file': 1,
  '--brief-add': 1,
  '--brief-add-file': 1,
  '--reasoning-mode': 1,
  '--agent': 1,
  '--agent-defs': 1,
  '--allowed-tools': 'many',
  '--block-tools': 'many',
  '--toolset': 'many',
  '--mcp': 'many',
  '--only-mcp': 0,
  '--config': 1,
  '--config-layers': 1,
  '--backup-model': 1,
  '--provider-preview': 'many',
  '--lean': 0,
  '--extension': 1,
  '--no-commands': 0,
  '--meter-tag': 1,
  '--log-file': 1,
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
    if (token === '--brief-add' && argv[i + 1] !== undefined) {
      append = argv[i + 1]!
      i += 1
      continue
    }
    if (token.startsWith('--brief-add=')) {
      append = token.slice('--brief-add='.length)
      continue
    }
    rest.push(token)
  }
  return { rest, append }
}
