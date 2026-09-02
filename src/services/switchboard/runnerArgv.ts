// ============================================================================
//  switchboard/runnerArgv — THE ONE TABLE of the boot options that belong to
//  a session's RUNNER.
//
//  A session inside the concourse is a full Mercury instance — the same
//  compute as a separately launched Mercury (parity 1:1). The screen is only
//  the face: the options an operator gives an interactive boot that shape
//  the ENGINE (the system prompt, thinking, the agent, the tool rules, the
//  MCP configs, the extra directories, the settings, the fallback model, the
//  betas, the bare posture, the extensions) ride into the session the first
//  message creates, exactly as typed. The screen extracts them from its
//  own argv through this table; the daemon admits only what the table
//  names (a runner never takes a print, session or transport option from a
//  request). The model, the effort, the permission mode and the title ride
//  their own typed fields, never this list.
// ============================================================================

/** flag → how many values follow: 0 (a switch), 1 (one value), 'many'
 *  (a variadic list — every following token that is not an option). */
const RUNNER_OPTIONS: Readonly<Record<string, 0 | 1 | 'many'>> = {
  '--system-prompt': 1,
  '--system-prompt-file': 1,
  '--append-system-prompt': 1,
  '--append-system-prompt-file': 1,
  '--thinking': 1,
  '--max-thinking-tokens': 1,
  '--agent': 1,
  '--agents': 1,
  '--allowedTools': 'many',
  '--allowed-tools': 'many',
  '--disallowedTools': 'many',
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

/** The runner-side options of an interactive boot's argv, in order, values
 *  attached — the tokens a session runner takes verbatim. A `--flag=value`
 *  spelling stays one token. Everything else (the prompt, the resume and
 *  session doors, the print and transport options, the model, the effort,
 *  the permission mode, the title) is the screen's or rides a typed field. */
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

/** The daemon's admission of a runner argv: every option must be one the
 *  table names, with its values in the shape the table gives it; a bounded
 *  list of bounded tokens. Returns the reason a list is refused, else null. */
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

/** Split an operator's `--append-system-prompt <text>` (either spelling)
 *  out of a runner argv: the runner's own posture text and the operator's
 *  words compose into ONE appendix — two flags would let the last one win. */
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
